/**
 * 0.13.0 Import clients (design 11, W27) against the fake API, with
 * made-up rows:
 *
 * - Choose a file (CSV or vCard, by its name or first line) or paste CSV;
 *   over 1 MB is refused on the phone. The preview lists each row that may
 *   already be a client with Skip (the default for the same e-mail or
 *   phone), Fill blanks (marks it as imported) or Add anyway, and the new
 *   ones. A changed column reads the file again with that mapping, and the
 *   import sends it.
 * - Import is one batch: "Added 2 clients, filled 1." with Undo import.
 * - The newest imports are listed with Undo while it can (7 days).
 * - An expired preview says the daemon's sentence.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkImportPreviewReply } from '@jantar/protocol/work';
import { ApiError } from '../../src/lib/api.js';
import { FIELD_LABEL, formatOf } from '../../src/ui/screens/work/ImportSheet.js';
import { WORK_IMPORT_FIELDS } from '@jantar/protocol/work';
import { fakeApi, preloadPlaces, renderApp, stateWith } from '../helpers.js';
import { IDS, WORK_ON, clientAnswers, lifeStatus, workRequest } from '../work-helpers.js';

preloadPlaces('work', 'clients');

afterEach(() => vi.restoreAllMocks());

const PREVIEW = '01JWRKPREV1EW0000000000001';
const CSV = 'name,email,company\nAcme Retail,hello@acme.example,Acme\nGlobex,team@globex.example,\nInitech,,\n';

function preview(over: Partial<WorkImportPreviewReply> = {}): WorkImportPreviewReply {
  return {
    previewId: PREVIEW,
    format: 'csv',
    columns: ['name', 'email', 'company'],
    mapping: ['name', 'email', 'company'],
    rows: [
      { index: 0, fields: { name: 'Acme Retail', kind: 'person', company: 'Acme', emails: ['hello@acme.example'], phones: [], tags: [], links: [] }, dup: { id: IDS.client, name: 'Acme', why: 'email' }, action: 'skip' },
      { index: 1, fields: { name: 'Globex', kind: 'company', emails: ['team@globex.example'], phones: [], tags: [], links: [] }, action: 'add' },
      { index: 2, fields: { name: 'Initech', kind: 'company', emails: [], phones: [], tags: [], links: [] }, action: 'add' },
    ],
    skipped: 1,
    expiresAt: '2026-01-15T10:35:00.000Z',
    ...over,
  };
}

function setup(request: Record<string, unknown> = {}) {
  const api = fakeApi({ lifeStatus: vi.fn(async () => WORK_ON()), request: workRequest(clientAnswers({ 'GET /v1/work/imports': { imports: [] }, ...request })) });
  return renderApp({ path: '/work?tab=clients', state: stateWith({ features: { life: true } }), api });
}

const calls = (api: { request: unknown }, method: string, path: string) =>
  (api.request as ReturnType<typeof workRequest>).mock.calls.filter(([r]) => r.method === method && r.path === path).map(([, init]) => init);

async function openImport() {
  await screen.findByRole('list', { name: 'Clients' });
  fireEvent.click(screen.getByRole('button', { name: 'More for clients' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Import a file' }));
  return screen.findByRole('dialog', { name: 'Import clients' });
}

const choose = (sheet: HTMLElement, file: File) => fireEvent.change(within(sheet).getByLabelText('Choose a file'), { target: { files: [file] } });

describe('import clients', () => {
  it('the columns are WORK_IMPORT_FIELDS, as words; a vCard by its name or its first line', () => {
    expect(Object.keys(FIELD_LABEL)).toEqual([...WORK_IMPORT_FIELDS]);
    expect(formatOf('contacts.VCF', '')).toBe('vcf');
    expect(formatOf('shared', 'BEGIN:VCARD\nVERSION:3.0')).toBe('vcf');
    expect(formatOf('clients.csv', 'name,email')).toBe('csv');
  });

  it('a file, its preview with a decision per match, one batch, and Undo import', async () => {
    const { api, toasts } = setup({
      'POST /v1/work/import/preview': preview(),
      'POST /v1/work/import': { batch: IDS.batch, added: 2, filled: 1, skipped: 0 },
      'DELETE /v1/work/import/:batch': { removed: 2, kept: 1 },
    });
    const sheet = await openImport();
    choose(sheet, new File([CSV], 'clients.csv', { type: 'text/csv' }));
    expect(await within(sheet).findByText(/3 rows, 1 left out/)).toBeTruthy();
    expect(calls(api, 'POST', '/v1/work/import/preview')[0]?.body).toEqual({ format: 'csv', text: CSV });
    const here = within(sheet).getByRole('region', { name: 'Already here' });
    expect(here.textContent).toMatch(/Already here: Acme \(same e-mail\)/);
    const decide = within(here).getByRole('group', { name: 'What to do with Acme Retail' });
    expect(within(decide).getByRole('button', { name: 'Skip' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(decide).getByRole('button', { name: 'Fill blanks' }));
    expect(within(here).getByText('Fill blanks · marks it as imported')).toBeTruthy();
    expect(within(within(sheet).getByRole('region', { name: 'New' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Globexteam@globex.example', 'Initech']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Import 2, fill 1' }));
    expect(await within(sheet).findByText('Added 2 clients, filled 1.')).toBeTruthy();
    expect(calls(api, 'POST', '/v1/work/import')[0]?.body).toEqual({
      previewId: PREVIEW,
      rows: [
        { index: 0, action: 'fill' },
        { index: 1, action: 'add' },
        { index: 2, action: 'add' },
      ],
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Undo import' }));
    await waitFor(() => expect(calls(api, 'DELETE', '/v1/work/import/:batch')).toEqual([expect.objectContaining({ params: { batch: IDS.batch } })]));
    expect(toasts.getState().toasts.map((t) => t.text)).toContain('Import undone: removed 2, kept 1 that changed since.');
  });

  it('a changed column reads the file again with that mapping, and the import sends it', async () => {
    const { api } = setup({
      'POST /v1/work/import/preview': (init: { body?: unknown }) => {
        const m = (init.body as { mapping?: string[] }).mapping;
        return preview(m ? { mapping: m as WorkImportPreviewReply['mapping'], previewId: '01JWRKPREV1EW0000000000002' } : {});
      },
      'POST /v1/work/import': { batch: IDS.batch, added: 2, filled: 0, skipped: 1 },
    });
    const sheet = await openImport();
    choose(sheet, new File([CSV], 'clients.csv'));
    fireEvent.click(await within(sheet).findByText('Columns (3)'));
    fireEvent.change(within(sheet).getByLabelText('Column company goes to'), { target: { value: 'notes' } });
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/import/preview')).toHaveLength(2));
    expect(calls(api, 'POST', '/v1/work/import/preview')[1]?.body).toEqual({ format: 'csv', text: CSV, mapping: ['name', 'email', 'notes'] });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Import 2' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/import')[0]?.body).toMatchObject({ previewId: '01JWRKPREV1EW0000000000002', mapping: ['name', 'email', 'notes'] }));
  });

  it('a vCard goes as one; over 1 MB is refused here; pasted CSV previews too', async () => {
    const { api } = setup({ 'POST /v1/work/import/preview': preview({ format: 'vcf', columns: [], mapping: [] }) });
    const sheet = await openImport();
    choose(sheet, new File(['x'.repeat(1_000_001)], 'big.csv'));
    expect(await within(sheet).findByText('That file is over 1 MB. Split it and import each part.')).toBeTruthy();
    expect(calls(api, 'POST', '/v1/work/import/preview')).toEqual([]);
    choose(sheet, new File(['BEGIN:VCARD\nVERSION:3.0\nFN:Globex\nEND:VCARD\n'], 'contact.vcf'));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/import/preview')[0]?.body).toMatchObject({ format: 'vcf' }));
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Back' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Paste CSV' }));
    fireEvent.change(within(sheet).getByLabelText('CSV'), { target: { value: 'name\nInitech\n' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/import/preview')[1]?.body).toEqual({ format: 'csv', text: 'name\nInitech\n' }));
  });

  it('a file the phone fails to hand over says so; pasted CSV over 1 MB says why Preview is off', async () => {
    const { api } = setup({ 'POST /v1/work/import/preview': preview() });
    const sheet = await openImport();
    const broken = new File(['name\n'], 'clients.csv');
    vi.spyOn(broken, 'text').mockRejectedValue(new DOMException('The file provider failed.', 'NotReadableError'));
    choose(sheet, broken);
    expect(await within(sheet).findByText("That file couldn't be read. Try again, or save it to Files first.")).toBeTruthy();
    expect(calls(api, 'POST', '/v1/work/import/preview')).toEqual([]);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Paste CSV' }));
    fireEvent.change(within(sheet).getByLabelText('CSV'), { target: { value: 'x'.repeat(1_000_001) } });
    expect((within(sheet).getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText('That is over 1 MB. Split it and paste each part.')).toBeTruthy();
  });

  it('a retry after a failed preview keeps its key only for the same words: another file of the same length gets a new one', async () => {
    let fail = true;
    const { api } = setup({ 'POST /v1/work/import/preview': () => (fail ? new ApiError('network', 'Failed to fetch', 0) : preview()) });
    const sheet = await openImport();
    choose(sheet, new File(['name\nAcme\n'], 'a.csv'));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/import/preview')).toHaveLength(1));
    choose(sheet, new File(['name\nAcme\n'], 'a.csv'));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/import/preview')).toHaveLength(2));
    fail = false;
    choose(sheet, new File(['name\nInit\n'], 'b.csv'));
    await waitFor(() => expect(calls(api, 'POST', '/v1/work/import/preview')).toHaveLength(3));
    const keys = calls(api, 'POST', '/v1/work/import/preview').map((c) => c?.idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('a recent import is listed on its day in the Life zone, not the UTC day', async () => {
    const api = fakeApi({
      lifeStatus: vi.fn(async () => lifeStatus({ todos: true, work: true }, { timezone: 'Asia/Kolkata' })),
      request: workRequest(clientAnswers({ 'GET /v1/work/imports': { imports: [{ batch: IDS.batch, at: '2026-01-13T21:20:00.000Z', added: 4, filled: 0, undoUntil: '2026-01-20T21:20:00.000Z' }] } })),
    });
    renderApp({ path: '/work?tab=clients', state: stateWith({ features: { life: true } }), api });
    const sheet = await openImport();
    const recent = await within(sheet).findByRole('region', { name: 'Recent imports' });
    // 21:20 UTC on the 13th is 02:50 on Wednesday the 14th in India.
    expect(within(recent).getByRole('listitem').textContent).toMatch(/^Wed 14 Jan · 4 added.*until 21 Jan/);
  });

  it('an expired preview says so; the newest imports are listed with Undo for 7 days', async () => {
    setup({
      'POST /v1/work/import/preview': preview(),
      'POST /v1/work/import': new ApiError('invalid_request', 'That preview has expired. Choose the file again.', 400),
      'GET /v1/work/imports': {
        imports: [
          { batch: IDS.batch, at: '2026-01-12T09:00:00.000Z', added: 84, filled: 3, undoUntil: '2026-01-19T09:00:00.000Z' },
          { batch: '01JWRKBATCH000000000000000', at: '2026-01-02T09:00:00.000Z', added: 5, filled: 0, undoUntil: '2026-01-09T09:00:00.000Z' },
        ],
      },
    });
    const sheet = await openImport();
    const recent = await within(sheet).findByRole('region', { name: 'Recent imports' });
    expect(within(recent).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringMatching(/Mon 12 Jan · 84 added, 3 filled.*until 19 Jan.*Undo/)]);
    choose(sheet, new File([CSV], 'clients.csv'));
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Import 2' }));
    expect(await within(sheet).findByText(/That preview has expired\. Choose the file again\./)).toBeTruthy();
  });
});
