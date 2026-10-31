/**
 * Answering a card. Answering can run commands on the Mac, so nothing is sent
 * until a button is pressed, and the server's verdicts are kept apart:
 *
 *   ok             the dock turns into a receipt (no toast, direction.md 5.2)
 *   needs_confirm  the daemon wants a second, explicit tap (TwoTap arm)
 *   error          an inline reason under the controls
 */
import { useState } from 'react';
import type { DecisionBody, PendingRequest } from '@jantar/protocol';
import { errorText, isApiError } from '../../../lib/api.js';
import { useDeps } from '../../context.js';

export type DecideResult = 'ok' | 'needs_confirm' | 'error';

/** What the receipt line says after an answer: `Answered "auth/session.ts"`. */
export interface Receipt {
  pendingId: string;
  text: string;
  /** ms */
  at: number;
  /** The answer also stopped Claude's turn. */
  stop?: boolean;
}

export type OnDecided = (r: Receipt) => void;

export function useDecide(p: PendingRequest, onDecided: OnDecided) {
  const { api } = useDeps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(body: DecisionBody, receipt: string): Promise<DecideResult> {
    setBusy(true);
    setError(null);
    try {
      await api.decide(p.id, body);
      onDecided({ pendingId: p.id, text: receipt, at: Date.now(), ...(body.interrupt ? { stop: true } : {}) });
      return 'ok';
    } catch (e) {
      if (isApiError(e, 'needs_confirm')) return 'needs_confirm';
      if (isApiError(e, 'conflict')) setError('This card was already answered or closed.');
      else if (isApiError(e, 'forbidden')) setError('This device can read but not approve. Pair it again with the control scope.');
      else setError(errorText(e));
      return 'error';
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, decide };
}

/** Receipt text for a card someone else answered. */
export function answeredBy(p: PendingRequest): string {
  const by = p.decidedBy ?? '';
  if (by.startsWith('device:')) return 'Answered on another device';
  if (by === 'cli' || by === 'local-ui') return 'Answered at the Mac';
  return 'Answered';
}
