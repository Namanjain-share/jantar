/**
 * v0.6 Fleet on Accounts (spec 0.6 and 6): once a machine is paired the
 * screen is one section per machine, the Mac first ("Mac · cswap" or "Mac ·
 * 1 login") and then each machine by name with how its accounts are read:
 * cswap as the Mac's rows ("Read at build-2"), config dirs as a list of
 * alias, dir and sessions under "No usage numbers on this machine". Every
 * machine's accounts are its own (every server has an account 0 or 1), so a
 * server's session never counts on the Mac's account of the same number.
 * With no machine paired the screen is v0.5's.
 */
import { screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { FLEET_COPY } from '@jantar/protocol';
import { asideOf, dirOf, modeWord } from '../src/ui/screens/accounts/Machines.js';
import { buildRows } from '../src/ui/screens/accounts/model.js';
import { account, NOW, renderApp, session, stateWith } from './helpers.js';
import { fleetNodes, fleetState, IDS, OFFLINE_AT } from './fleet-helpers.js';

// The machines' sections are their own chunk: load it once, before the tests wait for it.
beforeAll(async () => {
  await import('../src/ui/screens/accounts/Machines.js');
});

const macParts = () => ({ features: {}, accounts: [account(1), account(3)], sessions: [session('a', { account: 1, status: 'idle' })] });
const sections = () => [...document.querySelectorAll<HTMLElement>('section[data-machine]')].map((s) => s.dataset.machine);
// A lazy chunk's first render can take seconds on a busy machine.
const sectionOf = (name: string) => screen.findByRole('region', { name: `${name} accounts` }, { timeout: 10_000 });
const rail = (el: HTMLElement) => el.querySelector('h2')?.textContent;

describe('Accounts by machine', () => {
  it('shows the Mac first, then each machine by name with how its accounts are read', async () => {
    renderApp({ path: '/accounts', state: fleetState(macParts()) });
    await sectionOf('build-1');
    expect(screen.getAllByText('Mac · cswap').length).toBeGreaterThan(0);
    expect(sections()).toEqual(['build-1', 'build-2', 'build-3', 'mini-1', 'ro-1', 'win-1']);
    expect(rail(await sectionOf('build-1'))).toBe('build-1 · 2 config dirs');
    expect(rail(await sectionOf('build-2'))).toBe('build-2 · cswap');
    expect(rail(await sectionOf('win-1'))).toBe('win-1 · 1 login');
    // The Mac's section comes before every machine's.
    const mac = screen.getAllByText('Mac · cswap')[0]!;
    expect(mac.compareDocumentPosition(await sectionOf('build-1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lists a server's config dirs with their sessions, and says nothing reads usage there", async () => {
    renderApp({ path: '/accounts', state: fleetState(macParts()) });
    const s = await sectionOf('build-1');
    expect(within(s).getByText(FLEET_COPY.noUsage('build-1'))).toBeTruthy();
    const items = within(s).getAllByRole('listitem').filter((li) => li.dataset.account !== undefined);
    expect(items.map((li) => li.querySelector('div')?.textContent)).toEqual(['claude~/.claude1 session', 'work~/.claude-work2 sessions']);
    // No meters: there are no usage numbers in dirs mode.
    expect(within(s).queryByRole('meter')).toBeNull();
    // Each session links to its screen.
    expect(within(s).getAllByRole('link').length).toBe(3);
  });

  it("reads a cswap server's usage at that server, never the Mac's", async () => {
    renderApp({ path: '/accounts', state: fleetState(macParts()) });
    const s = await sectionOf('build-2');
    expect(within(s).getByText('Read at build-2')).toBeTruthy();
    const list = within(s).getByRole('list', { name: 'Accounts' });
    // build-2's 01 at 35% and 02 at 12%: the Mac's 01 is at 42%.
    expect(within(list).getAllByRole('listitem').map((li) => li.querySelector('.type-mono.font-key')?.textContent)).toEqual(['01', '02']);
    expect(list.textContent).toContain('35');
    expect(list.textContent).toContain('12');
    expect(list.textContent).not.toContain('42');
  });

  it('mutes an offline machine and says since when, never faded (its text keeps 4.5:1)', async () => {
    renderApp({ path: '/accounts', state: fleetState(macParts()) });
    const s = await sectionOf('build-3');
    expect(s.hasAttribute('data-offline')).toBe(true);
    expect(s.querySelector('[class*="opacity"]')).toBeNull();
    expect(s.className).not.toContain('opacity');
    expect(within(s).getByText('offline since 14:02').className).toContain('text-ink-2');
    expect(within(s).getByText('claude').className).toContain('text-ink-3');
    expect((await sectionOf('build-1')).hasAttribute('data-offline')).toBe(false);
  });

  it('names the Mac\'s one login as "Mac · 1 login" in single mode, with its own sessions only', async () => {
    const claude = { ...account(0, { alias: 'Claude', usageStatus: 'unknown', windows: [], emailMasked: '' }) };
    const s = fleetState({ features: {}, accountsMode: 'single', accounts: [claude], sessions: [session('a', { account: 0, status: 'idle' })] });
    renderApp({ path: '/accounts', state: s });
    await sectionOf('build-1');
    expect(screen.getByText('Mac · 1 login')).toBeTruthy();
    // The Mac's one login lists the Mac's session, not a server's account 0.
    const mac = document.querySelector<HTMLElement>('li[data-account="single"]')!;
    expect(mac.textContent).toContain('1 session');
    expect(within(mac).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/s/a']);
  });
});

describe("the Mac's accounts with machines paired", () => {
  it("count only the Mac's sessions (a server's account 1 is not the Mac's 01)", () => {
    const s = fleetState(macParts());
    const mac = buildRows(s, null, 97, NOW);
    expect(mac.map((r) => r.id)).toEqual([1, 3]);
    expect(mac.find((r) => r.id === 1)?.sessions.map((x) => x.sid)).toEqual(['a']);
    const b2 = buildRows(s, null, 97, NOW, IDS.build2);
    expect(b2.map((r) => r.id)).toEqual([1, 2]);
    expect(b2.find((r) => r.id === 1)?.sessions.map((x) => x.node)).toEqual([IDS.build2]);
    expect(b2.find((r) => r.id === 1)?.h5).toBe(35);
    // build-2's own default login, never the Mac's active account.
    expect(b2.find((r) => r.id === 1)?.flags.map((f) => f.text)).toContain('default login');
    // A machine the state doesn't know has no accounts.
    expect(buildRows(s, null, 97, NOW, 'nope')).toEqual([]);
  });
});

describe('the words', () => {
  it('say how each machine reads its accounts', () => {
    const n = fleetNodes();
    expect(modeWord(n[IDS.build1]!)).toBe('2 config dirs');
    expect(modeWord(n[IDS.build2]!)).toBe('cswap');
    expect(modeWord(n[IDS.win1]!)).toBe('1 login');
    expect(dirOf({ id: 0, alias: 'claude' })).toBe('~/.claude');
    expect(dirOf({ id: 2, alias: 'work' })).toBe('~/.claude-work');
    expect(asideOf(n[IDS.build2]!, NOW)).toBe('Read at build-2');
    expect(asideOf(n[IDS.build1]!, NOW)).toBe('No usage numbers on this machine');
    expect(asideOf({ ...n[IDS.build1]!, online: false, since: OFFLINE_AT }, NOW)).toBe('offline since 14:02');
  });
});

describe('with no machine paired', () => {
  it("is v0.5's screen, with nodes empty or absent", async () => {
    for (const nodes of [{}, undefined]) {
      const s = stateWith(macParts());
      if (nodes) s.nodes = nodes;
      else delete s.nodes;
      const { unmount } = renderApp({ path: '/accounts', state: s });
      expect(await screen.findByRole('list', { name: 'Accounts' })).toBeTruthy();
      expect(screen.queryByText('Mac · cswap')).toBeNull();
      expect(document.querySelector('section[data-machine]')).toBeNull();
      expect(screen.queryByRole('region', { name: 'Accounts on other machines' })).toBeNull();
      unmount();
    }
  });
});
