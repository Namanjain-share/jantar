/**
 * The phone's taps on a turn (spec 0.10 B7.3, B8): Undo a change, run a
 * card (Confirm a delete or an action, Do a held-back write), Dismiss one.
 * Every tap runs as the tapping device, within CHAT_UNDO_WITHIN_MS, only
 * while the item's part is on; a tap never runs inside a run.
 *
 * Undo: an add deletes the item as it is now (one already gone counts as
 * undone; a café with visits by then is refused); an edit, a todo's done,
 * a weight, the targets, a budget, the goals or a dose go back to what was
 * there before only while Chat's value still holds, else 409 "That changed
 * after Chat's edit; change it back by hand." A
 * Confirm has no Undo (the tap was the check); a Do-it's write becomes a
 * change of the turn, with its own Undo.
 */
import { CHAT_UNDO_WITHIN_MS } from '@jantar/protocol';
import type { Actor, DaemonContext, LifeResult } from '../contracts.js';
import { ACTION_SENTENCES, CardActionSchema, applyWrite, describeAction, describeDelete, runCardAction, undoJournal, type Journal } from './actions.js';
import type { ChatStore } from './store.js';
import { audit, partOn, recordChange } from './tools.js';
import type { ChatDeps } from './types.js';

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });

export const TAP_SENTENCES = {
  noTurn: 'No such message.',
  noChange: 'No such change.',
  noCard: 'No such card.',
  notUndoable: 'This one has no Undo.',
  undone: 'Already undone.',
  old: 'Over a day old. Change it in its own screen instead.',
  oldCard: 'Over a day old. Ask again.',
  taken: 'Already done.',
  dismissed: 'Dismissed.',
  off: 'That part is off. Turn it on at your Mac first.',
} as const;

export interface TapCtx {
  ctx: Pick<DaemonContext, 'settings' | 'clock' | 'db'>;
  deps: ChatDeps;
  store: ChatStore;
}

const tooOld = (o: TapCtx, at: string) => o.ctx.clock.now() - Date.parse(at) > CHAT_UNDO_WITHIN_MS;

/** Undo change `n` of turn `turnId` as `actor`. */
export async function undoChange(o: TapCtx, turnId: string, n: number, actor: Actor, actorName: string): Promise<LifeResult> {
  if (!o.store.turn(turnId)) return refuse('not_found', TAP_SENTENCES.noTurn);
  const found = o.store.change(turnId, n);
  if (!found) return refuse('not_found', TAP_SENTENCES.noChange);
  const { change, at, journal } = found;
  if (change.state === 'undone') return refuse('conflict', TAP_SENTENCES.undone);
  if (!change.undoable) return refuse('conflict', TAP_SENTENCES.notUndoable);
  if (change.state === 'expired' || tooOld(o, at) || !journal) return refuse('conflict', TAP_SENTENCES.old);
  // While the part is off its own writes are refused too: Undo is no way around a switch.
  if (!partOn(o.ctx.settings.get(), o.deps, change.module)) return refuse('forbidden', TAP_SENTENCES.off);
  const r = await undoJournal(o.deps, journal as Journal, actor);
  audit(o.ctx, actorName, 'chat.undo', turnId, { turnId, n, module: change.module, op: change.op, outcome: r.ok ? 'undone' : r.code }, r.ok ? 'ok' : 'failed');
  if (!r.ok) return r;
  o.store.setChangeState(turnId, n, 'undone');
  return { ok: true, value: true };
}

/** Run card `n` of turn `turnId` as `actor` (the tap is the check). */
export async function runCard(o: TapCtx, turnId: string, n: number, actor: Actor, actorName: string): Promise<LifeResult> {
  const turn = o.store.turn(turnId);
  if (!turn) return refuse('not_found', TAP_SENTENCES.noTurn);
  if (turn.state !== 'done') return refuse('conflict', 'Wait for the answer.');
  const found = o.store.card(turnId, n);
  if (!found) return refuse('not_found', TAP_SENTENCES.noCard);
  const { card, state, at } = found;
  if (state === 'done') return refuse('conflict', TAP_SENTENCES.taken);
  if (state === 'dismissed') return refuse('conflict', TAP_SENTENCES.dismissed);
  if (state === 'expired' || tooOld(o, at)) {
    if (state === 'waiting') o.store.setCardState(turnId, n, 'expired');
    return refuse('conflict', TAP_SENTENCES.oldCard);
  }
  if (state !== 'waiting') return refuse('conflict', card.reason ?? TAP_SENTENCES.taken);
  if (!partOn(o.ctx.settings.get(), o.deps, card.module)) return refuse('forbidden', TAP_SENTENCES.off);
  const parsed = CardActionSchema.safeParse(card.action);
  if (!parsed.success) return refuse('invalid_request', ACTION_SENTENCES.bad);
  const action = parsed.data;
  const done = (r: LifeResult): LifeResult => {
    audit(o.ctx, actorName, 'chat.card', turnId, { turnId, n, kind: card.kind, outcome: r.ok ? 'done' : 'failed' }, r.ok ? 'ok' : 'failed');
    if (r.ok) o.store.setCardState(turnId, n, 'done');
    else if (r.code === 'not_found') o.store.setCardState(turnId, n, 'failed', ACTION_SENTENCES.gone);
    return r;
  };
  if (action.t === 'write') {
    const r = await applyWrite(o.deps, action.tool, action.input, actor);
    if (!r.ok) return done(r);
    recordChange({ ctx: o.ctx, store: o.store, turnId, actorName }, r.value);
    return done({ ok: true, value: true });
  }
  // The item must still be there: describe it again, now.
  const again = action.t === 'delete' ? describeDelete(o.deps, action) : describeAction(o.deps, action);
  if (!again.ok) return done(again);
  return done(await runCardAction(o.deps, action, actor));
}

/** Dismiss card `n` (a waiting one; anything else answers as it is). */
export function dismissCard(o: TapCtx, turnId: string, n: number, actorName: string): LifeResult {
  if (!o.store.turn(turnId)) return refuse('not_found', TAP_SENTENCES.noTurn);
  const found = o.store.card(turnId, n);
  if (!found) return refuse('not_found', TAP_SENTENCES.noCard);
  if (found.state === 'done') return refuse('conflict', TAP_SENTENCES.taken);
  if (found.state === 'waiting') {
    o.store.setCardState(turnId, n, 'dismissed');
    audit(o.ctx, actorName, 'chat.card', turnId, { turnId, n, kind: found.card.kind, outcome: 'dismissed' }, 'ok');
  }
  return { ok: true, value: true };
}
