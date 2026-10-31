/**
 * jantar rewrite: switch Rewrite on or off at the Mac, keep its glossary and
 * pick its model (settings rewrite.*, Mac only; decisions U5 and U6).
 *
 * Rewrite turns what the user dictated (with the phone keyboard's own
 * speech-to-text) into a prompt, through one throwaway headless Claude run
 * per tap. The glossary is words it must spell exactly (project names,
 * tools); the phone sees none of these settings.
 */
import { RewriteModelSchema, type Settings } from '@jantar/protocol';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { readSettings } from '../lib/settings.js';
import { changeSettings, hasControlChars, onOff, parseOnOff } from '../lib/switches.js';
import { clip } from '../lib/text.js';

/** RewriteSettingsSchema's limits. */
const GLOSSARY_MAX = 200;
const WORD_MAX = 64;

function modelLine(r: Settings['rewrite']): string {
  return `Model: ${r.model} (effort ${r.effort}; ${r.fallbackModel} when ${r.model} is unavailable)\n`;
}

function glossaryLines(words: readonly string[]): string {
  return words.length ? `Glossary (${words.length}): ${words.map((w) => clip(w, WORD_MAX)).join(', ')}\n` : 'Glossary: empty. Add words: jantar rewrite glossary add <word...>\n';
}

/** A glossary word as typed, trimmed, or a usage error. */
function checkWord(w: string): string {
  const t = w.trim();
  if (!t || t.length > WORD_MAX) throw new UsageError(`a glossary word must be 1 to ${WORD_MAX} characters ("${clip(w, 20)}")`);
  if (hasControlChars(t)) throw new UsageError('a glossary word cannot hold control characters');
  return t;
}

async function glossary(ctx: CliContext, sub: string | undefined, words: readonly string[]): Promise<number> {
  const { settings } = await readSettings(ctx);
  const have = settings.rewrite.glossary;
  if (sub === undefined || sub === 'list') {
    if (words.length) throw new UsageError('glossary list takes no argument');
    ctx.io.out(glossaryLines(have));
    return EXIT.ok;
  }
  if (words.length === 0) throw new UsageError(`glossary ${sub} needs at least one word`);
  const given = words.map(checkWord);
  const key = (w: string) => w.toLowerCase();
  if (sub === 'add') {
    const next = [...have];
    for (const w of given) if (!next.some((h) => key(h) === key(w))) next.push(w);
    if (next.length > GLOSSARY_MAX) throw new UsageError(`the glossary holds at most ${GLOSSARY_MAX} words (it has ${have.length})`);
    if (next.length === have.length) {
      ctx.io.out(`Already in the glossary.\n${glossaryLines(have)}`);
      return EXIT.ok;
    }
    await changeSettings(ctx, { rewrite: { glossary: next } }, (s) => glossaryLines(s.rewrite.glossary));
    return EXIT.ok;
  }
  if (sub === 'rm' || sub === 'remove') {
    const drop = new Set(given.map(key));
    const next = have.filter((h) => !drop.has(key(h)));
    if (next.length === have.length) throw new Error(`none of those words is in the glossary`);
    await changeSettings(ctx, { rewrite: { glossary: next } }, (s) => glossaryLines(s.rewrite.glossary));
    return EXIT.ok;
  }
  throw new UsageError(`unknown glossary action "${sub}" (add, rm or list)`);
}

export default defineCommand(
  {
    name: 'rewrite',
    summary: 'Turn Rewrite (dictated text into a prompt) on or off, and set its glossary and model.',
    usage: 'jantar rewrite <on|off|status|glossary [add|rm <word...>]|model [opus|sonnet|haiku]>',
    owner: 'T2',
    help:
      '  rewrite on | off                  show or hide Rewrite next to Send on the phone\n' +
      '  rewrite status                    the switch, the model and the glossary\n' +
      '  rewrite glossary add <word...>    words the prompt writer must spell exactly (project names, tools)\n' +
      '  rewrite glossary rm <word...>     remove words\n' +
      '  rewrite model <m>                 the model that writes prompts (default opus; "Rewrite with Sonnet" stays on the phone)\n' +
      'Rewrite runs one headless claude per tap on an account with room (never accounts held for other work).',
  },
  async (argv, ctx) => {
    const { positionals } = parseArgs(argv, {}, { min: 1 });
    const [action, sub, ...rest] = positionals;
    switch (action) {
      case 'on':
      case 'off': {
        if (sub !== undefined) throw new UsageError(`${action} takes no argument`);
        const on = parseOnOff(action, 'rewrite');
        await changeSettings(ctx, { rewrite: { enabled: on } }, (s) =>
          on
            ? `Rewrite is on. The phone shows Rewrite next to Send.\n${modelLine(s.rewrite)}`
            : 'Rewrite is off. The phone no longer shows it; typing and sending work as before.\n',
        );
        return EXIT.ok;
      }
      case 'status': {
        if (sub !== undefined) throw new UsageError('status takes no argument');
        const r = (await readSettings(ctx)).settings.rewrite;
        ctx.io.out(`Rewrite: ${onOff(r.enabled)}\n${modelLine(r)}${glossaryLines(r.glossary)}`);
        return EXIT.ok;
      }
      case 'glossary':
        return glossary(ctx, sub, rest);
      case 'model': {
        if (rest.length) throw new UsageError(`unexpected argument "${rest[0]}"`);
        if (sub === undefined) {
          ctx.io.out(modelLine((await readSettings(ctx)).settings.rewrite));
          return EXIT.ok;
        }
        const m = RewriteModelSchema.safeParse(sub);
        if (!m.success) throw new UsageError(`model must be one of ${RewriteModelSchema.options.join(', ')}`);
        await changeSettings(ctx, { rewrite: { model: m.data } }, (s) => modelLine(s.rewrite));
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown action "${action}" (on, off, status, glossary or model)`);
    }
  },
);
