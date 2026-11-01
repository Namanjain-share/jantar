/**
 * The launch film's fixture (web-fixture-film.ts), so no picture of it can
 * show an impossible state:
 *
 * - every stage's state, and session 3's transcript, parse with the
 *   protocol's own schemas;
 * - 'before' has three sessions that need you and the Bash card; 'answered',
 *   'migrating', 'testing' and 'done' two, with session 3 working on each
 *   command of the run in turn, then idle with the reply; its transcript
 *   keeps the same history at every stage and grows by the run;
 * - the push the film draws is what the daemon's notify/format.ts writes for
 *   that card, with full bodies (the default);
 * - api-server's Terminal screen is read by the daemon's dialogOfScreen as
 *   the same Bash permission, and every line fits the drawn window (96
 *   columns);
 * - nothing in it points at a real home or account.
 */
import { describe, expect, it } from 'vitest';
import { StateResponseSchema, TranscriptResponseSchema, needsYou, type Session } from '@jantar/protocol';
import { dialogOfScreen } from '@jantar/daemon/terminal/dialog';
import { cardNotification } from '@jantar/daemon/notify/format';
import { FILM_COMMAND, FILM_HISTORY, FILM_REPLY, FILM_RUN, FILM_SID, FILM_STAGES, FILM_TERMINAL, webFixtureFilm } from './web-fixture-film.js';

const BASE = 'http://127.0.0.1:1';

describe('webFixtureFilm', () => {
  const stages = Object.fromEntries(FILM_STAGES.map((s) => [s, webFixtureFilm({ stage: s })])) as Record<(typeof FILM_STAGES)[number], ReturnType<typeof webFixtureFilm>>;

  it('holds a state the protocol accepts at every stage', () => {
    for (const [stage, f] of Object.entries(stages)) {
      const parsed = StateResponseSchema.safeParse(f.state);
      expect(parsed.success, `${stage}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      const talk = f.v04.answer('GET', new URL(`/v1/sessions/${FILM_SID}/transcript`, BASE));
      expect(talk?.status, stage).toBe(200);
      expect(TranscriptResponseSchema.safeParse(talk?.body).success, stage).toBe(true);
    }
  });

  it('tells the story: the card, then working on it, then your turn', () => {
    const need = (stage: keyof typeof stages) => {
      const st = stages[stage].state.state;
      return Object.values(st.sessions).filter((s) => needsYou(st, s.sid)).length;
    };
    expect(FILM_STAGES.map(need)).toEqual([3, 2, 2, 2, 2]);

    const card = Object.values(stages.before.state.state.pending).find((p) => p.sid === FILM_SID);
    expect(card?.tool).toBe('Bash');
    expect((card?.input as { command?: string }).command).toBe(FILM_COMMAND);
    for (const stage of ['answered', 'migrating', 'testing', 'done'] as const) {
      expect(Object.values(stages[stage].state.state.pending).some((p) => p.sid === FILM_SID), stage).toBe(false);
    }

    const s3 = (stage: keyof typeof stages) => stages[stage].state.state.sessions[FILM_SID] as Session;
    for (const [i, stage] of (['answered', 'migrating', 'testing'] as const).entries()) {
      expect(s3(stage).status, stage).toBe('working');
      expect(s3(stage).now, stage).toEqual({ kind: 'tool', tool: FILM_RUN[i]![0], text: FILM_RUN[i]![1] });
    }
    expect(s3('answered').now?.text).toBe(FILM_COMMAND);
    expect(s3('done').status).toBe('idle');
    expect(s3('done').now).toBeUndefined();
    expect(s3('done').lastReply?.text).toBe(FILM_REPLY);

    const talk = (stage: keyof typeof stages) =>
      (stages[stage].v04.answer('GET', new URL(`/v1/sessions/${FILM_SID}/transcript`, BASE))!.body as { items: Array<{ kind: string; text: string }> }).items;
    expect(talk('answered')[0]).toMatchObject({ kind: 'tool_use', text: FILM_COMMAND });
    expect(talk('migrating')[0]).toMatchObject({ kind: 'tool_use', text: FILM_RUN[1]![1] });
    expect(talk('testing')[0]).toMatchObject({ kind: 'tool_use', text: FILM_RUN[2]![1] });
    expect(talk('done')[0]).toMatchObject({ kind: 'text', text: FILM_REPLY });
    // The same history under every stage, oldest last; the run only adds to the top.
    const oldest = FILM_HISTORY.map((h) => h[3]).reverse();
    for (const stage of FILM_STAGES) expect(talk(stage).slice(-FILM_HISTORY.length).map((i) => i.text), stage).toEqual(oldest);
    expect(talk('before')).toHaveLength(5 + FILM_HISTORY.length);
    expect(talk('done')).toHaveLength(5 + FILM_HISTORY.length + FILM_RUN.length + 1);
  });

  it('pushes what the daemon writes for the card', () => {
    const f = stages.before;
    const card = Object.values(f.state.state.pending).find((p) => p.sid === FILM_SID)!;
    const n = cardNotification(card, f.state.state.sessions[FILM_SID], 'full', new Date(f.now).toISOString());
    expect(n?.title).toBe('api-server needs you');
    expect(n?.body).toBe(`Permission · Bash: ${FILM_COMMAND}`);
  });

  it('draws a Terminal the daemon reads as the same prompt', () => {
    const screen = FILM_TERMINAL.screens['api-server'].lines.join('\n');
    const read = dialogOfScreen(screen);
    expect(read.note).toBeNull();
    expect(read.dialog?.kind).toBe('permission');
    expect(screen).toContain(FILM_COMMAND);
    expect(FILM_TERMINAL.tabs).toHaveLength(12);
    for (const name of Object.keys(FILM_TERMINAL.screens)) expect(FILM_TERMINAL.tabs).toContain(name);
    const all = [...Object.values(FILM_TERMINAL.screens).flatMap((t) => t.lines), ...FILM_TERMINAL.context, ...FILM_TERMINAL.after, FILM_TERMINAL.reply];
    for (const line of all) expect([...line].length, line).toBeLessThanOrEqual(96);
    expect(FILM_TERMINAL.reply).toContain(FILM_REPLY);
  });

  it('points at nothing real', () => {
    const text = JSON.stringify([stages.done.state, FILM_TERMINAL]);
    expect(text.match(/\/Users\/(?!you\/)[^"/]+/g) ?? []).toEqual([]);
    expect(text).not.toMatch(/@(?!e\*\*\*\.com)[a-z0-9-]+\.[a-z]{2,}/i);
  });
});
