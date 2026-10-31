/**
 * The questions `jantar init` asks, on the terminal (`io.ask`). With
 * `--yes` every question takes its default without asking; an answer that
 * does not parse is asked again, then the default stands.
 */
import type { CliIo } from '../../io.js';

/** How many times a question that got an answer it cannot use is asked. */
const TRIES = 3;

export interface Asker {
  /** --yes: every default, nothing asked. */
  readonly auto: boolean;
  yesNo(question: string, def: boolean): Promise<boolean>;
  /** One of `choices` by its number (1-based) or its key; `def` is a key. */
  choose<K extends string>(question: string, choices: readonly { key: K; label: string }[], def: K): Promise<K>;
  /** Free text, trimmed; '' (just Enter) when nothing is typed. */
  text(question: string): Promise<string>;
  /** Parse an answer, asking again (with the reason) while it does not parse; the default after TRIES. */
  parsed<T>(question: string, parse: (answer: string) => { ok: true; value: T } | { ok: false; reason: string }, def: T): Promise<T>;
}

export function createAsker(io: CliIo, auto: boolean): Asker {
  const ask = async (q: string): Promise<string> => (auto || !io.ask ? '' : (await io.ask(q)).trim());
  const asker: Asker = {
    auto,
    async yesNo(question, def) {
      if (auto) return def;
      for (let i = 0; i < TRIES; i++) {
        const a = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
        if (a === '') return def;
        if (a === 'y' || a === 'yes') return true;
        if (a === 'n' || a === 'no') return false;
        io.err('  Answer y or n.\n');
      }
      return def;
    },
    async choose(question, choices, def) {
      if (auto) return def;
      const at = choices.findIndex((c) => c.key === def) + 1;
      const lines = choices.map((c, i) => `  ${i + 1}. ${c.label}${c.key === def ? ' (default)' : ''}`).join('\n');
      return asker.parsed(
        `${question}\n${lines}\nPick 1-${choices.length} [${at}]: `,
        (a) => {
          if (a === '') return { ok: true, value: def };
          const n = Number(a);
          const byNumber = Number.isInteger(n) ? choices[n - 1] : undefined;
          const hit = byNumber ?? choices.find((c) => c.key === a);
          return hit ? { ok: true, value: hit.key } : { ok: false, reason: `pick a number from 1 to ${choices.length}` };
        },
        def,
      );
    },
    text: (question) => ask(question),
    async parsed(question, parse, def) {
      if (auto) return def;
      for (let i = 0; i < TRIES; i++) {
        const r = parse(await ask(question));
        if (r.ok) return r.value;
        io.err(`  ${r.reason}\n`);
      }
      return def;
    },
  };
  return asker;
}
