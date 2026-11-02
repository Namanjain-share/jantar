/**
 * chat.db and its rows (spec 0.10 B3): created 0600, secure_delete on,
 * refused never reset (random bytes, a newer schema), the page cursor,
 * changes and cards with their journal, photo rows, the retention sweep by
 * days, by count, the 24 h journal purge and unattached photos, Clear.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LifeDb } from '../../src/contracts.js';
import { CHAT_BROKEN_REASON, CHAT_SCHEMA_VERSION, openChatDb } from '../../src/chat/db.js';
import { ChatStore, type TurnRecord } from '../../src/chat/store.js';

let dir: string;
let file: string;
const opened: LifeDb[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jantar-chatdb-')));
  chmodSync(dir, 0o700);
  file = join(dir, 'chat.db');
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function store(path = file): ChatStore {
  const r = openChatDb(path);
  if (!r.ok) throw new Error(r.reason);
  opened.push(r.db);
  return new ChatStore(r.db);
}

let seq = 0;
function ulid(): string {
  seq += 1;
  return `01J${String(seq).padStart(23, '0')}`;
}

function turn(at: string, over: Partial<TurnRecord> = {}): TurnRecord {
  return { id: ulid(), at, via: 'phone', text: 'Add oat milk to my list', photos: [], state: 'done', tainted: false, refused: 0, by: 'device:synthetic', ...over };
}

describe('chat.db', () => {
  it('is created 0600 with secure_delete on and schema 1', () => {
    store();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const db = opened[0]!;
    expect(db.meta('schema')).toBe(String(CHAT_SCHEMA_VERSION));
    expect((db.raw.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete).toBe(1);
  });

  it('refuses, never resets: random bytes, a newer schema', () => {
    writeFileSync(file, randomBytes(8192));
    const before = sha(file);
    const r = openChatDb(file);
    expect(r).toMatchObject({ ok: false, reason: CHAT_BROKEN_REASON });
    expect(sha(file)).toBe(before);

    const newer = join(dir, 'newer.db');
    store(newer);
    opened.pop()!.close();
    const raw = new DatabaseSync(newer);
    raw.exec(`UPDATE meta SET value = '${CHAT_SCHEMA_VERSION + 1}' WHERE key = 'schema'`);
    raw.close();
    const h = sha(newer);
    expect(openChatDb(newer)).toMatchObject({ ok: false, code: 'newer_schema' });
    expect(sha(newer)).toBe(h);
  });
});

describe('ChatStore', () => {
  it('pages the newest turns, oldest first, with an older cursor', () => {
    const s = store();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = turn(`2026-11-02T10:0${i}:00.000Z`);
      s.insertTurn(t);
      ids.push(t.id);
    }
    const p = s.page(undefined, 2);
    expect(p.turns.map((t) => t.id)).toEqual(ids.slice(3));
    expect(p.older).toBe(ids[3]);
    const q = s.page(p.older ?? undefined, 2);
    expect(q.turns.map((t) => t.id)).toEqual(ids.slice(1, 3));
    expect(s.page(ids[1], 2)).toEqual({ turns: [expect.objectContaining({ id: ids[0] })], older: null });
    expect(s.before(ids[4]!, 12).map((t) => t.id)).toEqual(ids.slice(0, 4));
  });

  it('keeps changes with their journal and cards with their action; the phone shape drops who sent it', () => {
    const s = store();
    const t = turn('2026-11-02T10:00:00.000Z');
    s.insertTurn(t);
    const n = s.addChange(t.id, t.at, { module: 'todos', op: 'add', ref: 'T1', label: 'Todo · Buy oat milk', undoable: true }, { after: { id: 'T1' } });
    expect(n).toBe(0);
    expect(s.change(t.id, 0)).toMatchObject({ change: { n: 0, state: 'done', ref: 'T1' }, journal: { after: { id: 'T1' } } });
    const c = s.addCard(t.id, t.at, { kind: 'confirm', module: 'todos', op: 'delete', ref: 'T1', label: 'Delete todo Buy oat milk?', action: { kind: 'todo', id: 'T1' } });
    expect(c).toBe(0);
    s.setCardState(t.id, 0, 'failed', 'That is gone.');
    const full = s.full(s.turn(t.id)!);
    expect(full).not.toHaveProperty('by');
    expect(full.changes).toEqual([{ n: 0, module: 'todos', op: 'add', ref: 'T1', label: 'Todo · Buy oat milk', state: 'done', undoable: true }]);
    expect(full.cards).toEqual([{ n: 0, kind: 'confirm', module: 'todos', op: 'delete', ref: 'T1', label: 'Delete todo Buy oat milk?', state: 'failed', reason: 'That is gone.' }]);
    expect(s.card(t.id, 0)?.card.action).toEqual({ kind: 'todo', id: 'T1' });
  });

  it('attaches free photos once', () => {
    const s = store();
    const t = turn('2026-11-02T10:00:00.000Z');
    s.insertTurn(t);
    s.addPhoto({ id: 'P1', turnId: null, at: t.at, bytes: 10, w: 2, h: 3, type: 'image/jpeg' });
    expect(s.attach(t.id, ['P1', 'P2'])).toEqual(['P1']);
    expect(s.attach('other', ['P1'])).toEqual([]);
    expect(s.photosOf(t.id).map((p) => p.id)).toEqual(['P1']);
  });

  it('the sweep: by days and by count (never an unfinished turn), the journal after a day, loose photos after an hour', () => {
    const s = store();
    const old = turn('2026-10-01T10:00:00.000Z');
    const running = turn('2026-10-01T10:00:01.000Z', { state: 'running' });
    const recent = turn('2026-11-02T09:00:00.000Z');
    const newest = turn('2026-11-02T09:30:00.000Z');
    for (const t of [old, running, recent, newest]) s.insertTurn(t);
    s.addPhoto({ id: 'OLD', turnId: old.id, at: old.at, bytes: 5, w: 1, h: 1, type: 'image/png' });
    s.addPhoto({ id: 'LOOSE', turnId: null, at: '2026-11-02T08:00:00.000Z', bytes: 5, w: 1, h: 1, type: 'image/png' });
    s.addPhoto({ id: 'FRESH', turnId: null, at: '2026-11-02T09:59:00.000Z', bytes: 5, w: 1, h: 1, type: 'image/png' });
    s.addChange(recent.id, '2026-11-01T08:00:00.000Z', { module: 'food', op: 'add', ref: 'F1', label: 'Meal', undoable: true }, { before: null });
    s.addCard(recent.id, '2026-11-01T08:00:00.000Z', { kind: 'confirm', module: 'food', op: 'delete', ref: 'F1', label: 'Delete meal?', action: {} });
    const r = s.sweep({ cutoffIso: '2026-10-03T10:00:00.000Z', maxTurns: 1, undoCutoffIso: '2026-11-01T10:00:00.000Z', unattachedCutoffIso: '2026-11-02T09:00:00.000Z' });
    expect(r.photos.map((p) => p.id).sort()).toEqual(['LOOSE', 'OLD']);
    expect(s.page(undefined, 10).turns.map((t) => t.id)).toEqual([running.id, newest.id]);
    expect(r.turns).toBe(2);
    expect(s.photo('FRESH')).not.toBeNull();
  });

  it('expires the journal and waiting cards after the Undo window', () => {
    const s = store();
    const t = turn('2026-11-02T09:00:00.000Z');
    s.insertTurn(t);
    s.addChange(t.id, '2026-11-01T08:00:00.000Z', { module: 'food', op: 'add', ref: 'F1', label: 'Meal', undoable: true }, { before: null });
    s.addCard(t.id, '2026-11-01T08:00:00.000Z', { kind: 'confirm', module: 'food', op: 'delete', ref: 'F1', label: 'Delete meal?', action: {} });
    s.sweep({ cutoffIso: '2026-01-01T00:00:00.000Z', maxTurns: 100, undoCutoffIso: '2026-11-01T10:00:00.000Z', unattachedCutoffIso: '2026-01-01T00:00:00.000Z' });
    expect(s.change(t.id, 0)).toMatchObject({ change: { state: 'expired' }, journal: null });
    expect(s.cards(t.id)[0]?.state).toBe('expired');
  });

  it('Clear empties every table', () => {
    const s = store();
    const t = turn('2026-11-02T09:00:00.000Z');
    s.insertTurn(t);
    s.addPhoto({ id: 'P', turnId: t.id, at: t.at, bytes: 5, w: 1, h: 1, type: 'image/png' });
    s.addChange(t.id, t.at, { module: 'food', op: 'add', ref: 'F1', label: 'Meal', undoable: true }, null);
    s.clear();
    expect(s.turnCount()).toBe(0);
    expect(s.photoCount()).toBe(0);
    expect(s.changes(t.id)).toEqual([]);
  });
});
