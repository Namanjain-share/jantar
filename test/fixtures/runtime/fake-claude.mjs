// Fake `claude -p` for the Rewrite (prompt-writer) tests. Plain JavaScript.
//
// It runs in-process when the fake cswap gets `run ... -- -p ...` (real cswap
// execs claude with the account's CLAUDE_CONFIG_DIR), or from the fake
// `claude` wrapper. Only print mode is faked; it never writes a transcript.
//
// Every run is appended to <root>/calls/claude.jsonl as
//   {name:'claude', args, stdin, cwd, env:{...subset}, envKeys, envMarkers, ts, pid, account, via, bin}
// and its output is chosen by, in order:
//   1. the first matching rule in <root>/fake/claude.json
//      {rules:[{match:{args?, argsPrefix?, argsIncludes?, stdinIncludes?, account?},
//               mode? | stdout?, stderr?, code?, delayMs?}], mode?, delayMs?, slowMs?, ignoreSignals?}
//      (a rule with `mode` picks a mode; one without answers verbatim);
//   2. a `FAKE_CLAUDE_MODE:<mode>` marker in stdin;
//   3. $FAKE_CLAUDE_MODE;
//   4. the file's `mode`, else `clean`.
// Like the real one it refuses a --system-prompt-file that does not exist and
// a --fallback-model equal to --model, before any mode is looked at.
// SIGINT and SIGTERM are appended to <root>/calls/claude.signals.jsonl from
// the moment the process starts; it then exits 130 / 143, unless the file's
// `ignoreSignals` names the signal (a claude that has to be killed harder).
//
// Food mode (v0.4 Ask Claude): when --system-prompt-file ends in
// estimate-v1.md it reads the <meal> block from stdin and answers with
// FOOD_MODES, picked the same way (default food-ok):
//   food-ok             "2 rotis and dal" gives Roti 240 and Dal 180 kcal; any other
//                       text one item named after its first word (100 kcal)
//   food-fence          the same JSON inside a ```json code fence
//   food-bad-json       JSON cut short
//   food-too-many       25 items
//   food-negative       a row with negative kcal
//   food-answer         prose instead of JSON
//   food-refuse-option  "error: unknown option '--permission-prompts'" while that flag
//                       is in argv (claude's own words), else food-ok
// plus slow, auth-error and empty as above. It is logged like every run.
//
// Meetings mode (v0.5 meeting summary): when --system-prompt-file ends in
// summary-v1.md it reads the <meeting_transcript> block from stdin (one
// "[HH:MM] Speaker: text" line per turn) and answers with MEETING_MODES,
// picked the same way (default meeting-ok):
//   meeting-ok        a summary naming the first speaker and the line count, two
//                     decisions, two action items owned by the first two speakers;
//                     a MEET-MARKER-… in stdin is copied into all three
//   meeting-fence     the same JSON inside a ```json code fence
//   meeting-bad-json  JSON cut short, and the first turn's text on stderr
//   meeting-too-many  31 action items
//   meeting-long      a 2,001-character summary
//   meeting-answer    prose instead of JSON
// plus slow, auth-error and empty as above. It is logged like every run.
//
// Ask mode (v0.5.3 Ask): when --system-prompt-file ends in assistant-v<N>.md
// it reads <now> (the Today and Time lines) and <message> from stdin, with
// the daemon's tag escapes undone, and answers with ASK_MODES, picked the
// same way (default ask-ok):
//   ask-ok             the first match on the message, any case:
//                      "todo add X" a todo titled X;
//                      "remind me every day at H:MM to X" a daily todo at H:MM with no day;
//                      "remind me to X [tomorrow] at H:MM" a todo on today (or tomorrow) at H:MM;
//                      "remind me at H to X" (no am or pm) a todo at the next H o'clock:
//                        H:00 today, else H+12:00 today, else H:00 tomorrow;
//                      "had 2 rotis and dal" Roti 240 and Dal 180 kcal;
//                      "ate X [N kcal]" or "had X [N kcal]" a food X (N, else 100 kcal);
//                      "spent N on X" an expense of N, category "food" (lower case), note X;
//                      "calories left", "what's due", "meds" a show card;
//                      "<kind> [on <where>] [tomorrow] <H>am|pm about X" (v0.7) a post
//                        idea of that kind at H (today, or tomorrow), titled "About X":
//                        on reddit when where starts r/, on x for a thread, else instagram;
//                      anything else a reply only. The reply names the message, so a
//                      marker in it stays in the titles and the reply.
//   ask-fence          the ask-ok JSON inside a ```json code fence
//   ask-bad-json       JSON cut short, and the message on stderr
//   ask-answer         prose instead of JSON
//   ask-not-object     []
//   ask-unknown-type   one todo plus shell, settings, medicine, session and intel actions
//   ask-extra-field    a todo with projectId, a todo with id, a food with save, money with billId
//   ask-too-many       15 todos
//   ask-bad-values     a todo today at 00:00 and a weekly one at 00:00 (both kept), then
//                      13 actions each with one bad value
//   ask-long-reply     a 2,000-character reply with U+202E, U+0007 and a Markdown link
//   ask-claims         "Done! I added 50000 to your expenses." and a money action of 50000
//   ask-refuse-option  "error: unknown option '--permission-prompts'" while that flag
//                      is in argv (claude's own words), else ask-ok
// plus slow, auth-error and empty as above. It is logged like every run.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ENV_KEYS, matches, readJson, record, recordedEnv, sleep } from './lib.mjs';

export const MODES = ['clean', 'auth-error', 'empty', 'invent', 'answer', 'preface', 'bang', 'slow', 'unknown-option', 'rate-limit'];

/** Ask Claude's modes (the food mode, see the file comment). */
export const FOOD_MODES = [
  'food-ok',
  'food-fence',
  'food-bad-json',
  'food-too-many',
  'food-negative',
  'food-answer',
  'food-refuse-option',
  'slow',
  'auth-error',
  'empty',
];

/** The meeting summary's modes (the meetings mode, see the file comment). */
export const MEETING_MODES = [
  'meeting-ok',
  'meeting-fence',
  'meeting-bad-json',
  'meeting-too-many',
  'meeting-long',
  'meeting-answer',
  'slow',
  'auth-error',
  'empty',
];

/** Ask's modes (the ask mode, see the file comment). */
export const ASK_MODES = [
  'ask-ok',
  'ask-fence',
  'ask-bad-json',
  'ask-answer',
  'ask-not-object',
  'ask-unknown-type',
  'ask-extra-field',
  'ask-too-many',
  'ask-bad-values',
  'ask-long-reply',
  'ask-claims',
  'ask-refuse-option',
  'slow',
  'auth-error',
  'empty',
];

const VERSION = '2.1.300';
/** Long enough to pass rewrite.timeoutS (120 s); tests cut it short with their own timeout. */
const DEFAULT_SLOW_MS = 150_000;

// What the prompt writer's env must or must not carry (spec 4.3, rule R3).
const CLAUDE_ENV_KEYS = [
  ...ENV_KEYS,
  'JANTAR_SKIP_HOOKS',
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'FAKE_CLAUDE_MODE',
];

// Tags the dictated text may arrive in; the first one found wins.
const TEXT_TAGS = ['transcript', 'dictated_text', 'dictated', 'user_text', 'text'];

/**
 * The dictated text from the prompt writer's context: the last block of the
 * first known tag, else all of stdin. The context escapes our tags inside
 * data ("</x>" as "<\/x>", "<x>" as "<\x>"); both are undone here.
 */
export function dictatedText(stdin) {
  for (const tag of TEXT_TAGS) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
    let last = null;
    for (const m of stdin.matchAll(re)) last = m[1];
    if (last !== null) return last.replace(/<\\(\/?)/g, '<$1').trim();
  }
  return stdin.trim();
}

/** Mode `clean`: fillers dropped, spaces squashed, first letter capitalised. Mirrored by fakeCleanRewrite() in src/rewrite.ts. */
export function cleanText(text) {
  const out = text
    .replace(/\b(?:haan toh|basically|matlab|um+|uh+)\b[,.]?/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return out ? out[0].toUpperCase() + out.slice(1) : '';
}

function optionValue(args, name) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

/** stdin as `--input-format stream-json` sends it: user messages, one JSON per line. */
function streamJsonText(stdin) {
  const parts = [];
  for (const line of stdin.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      const c = m?.message?.content;
      if (typeof c === 'string') parts.push(c);
      else if (Array.isArray(c)) for (const b of c) if (typeof b?.text === 'string') parts.push(b.text);
    } catch {
      // not JSON: ignore the line, as claude would reject it
    }
  }
  return parts.join('\n');
}

function pickMode(config, args, stdin, account, modes = MODES, fallback = 'clean') {
  const rule = (config.rules || []).find((r) => matches(r.match, args, stdin, { account }));
  if (rule) return { rule };
  const marker = /FAKE_CLAUDE_MODE:([a-z-]+)/.exec(stdin)?.[1];
  const mode = marker || process.env.FAKE_CLAUDE_MODE || config.mode || fallback;
  return { mode: modes.includes(mode) ? mode : fallback };
}

/** The meal from Ask Claude's stdin (`<meal>\n...\n</meal>`), with the daemon's "<\/meal>" escape undone. */
export function mealText(stdin) {
  const m = /<meal>\n?([\s\S]*?)\n?<\/meal>/.exec(stdin);
  return (m ? m[1] : stdin).replace(/<\\\//g, '</').trim();
}

/** Food mode's answer: the estimate JSON (or what a mode makes of it) as the result text. */
function foodResultFor(mode, meal) {
  if (mode === 'auth-error' || mode === 'empty') return resultFor(mode, meal);
  const first = meal.split(/\s+/)[0] ?? '';
  const estimate = /^2 rotis and dal\b/i.test(meal)
    ? { items: [{ name: 'Roti', kcal: 240 }, { name: 'Dal', kcal: 180 }], note: 'Assumed 2 medium rotis and 1 bowl of dal.' }
    : first
      ? { items: [{ name: first, kcal: 100 }] }
      : { items: [], note: 'No food or drink named.' };
  const json = JSON.stringify(estimate);
  switch (mode) {
    case 'food-fence':
      return { result: `\`\`\`json\n${json}\n\`\`\`` };
    case 'food-bad-json':
      return { result: json.slice(0, -5) };
    case 'food-too-many':
      return { result: JSON.stringify({ items: Array.from({ length: 25 }, (_, i) => ({ name: `Item ${i + 1}`, kcal: 10 })) }) };
    case 'food-negative':
      return { result: JSON.stringify({ items: [{ name: 'Roti', kcal: -240 }] }) };
    case 'food-answer':
      return { result: 'A roti has about 120 kcal and a bowl of dal about 180, so roughly 420 kcal in all.' };
    default:
      return { result: json };
  }
}

/**
 * The turns of the meeting summary's stdin: each "[HH:MM] Speaker: text"
 * line inside <meeting_transcript> (the "lines left out" line is not a turn),
 * with the daemon's "<\/meeting" escape undone.
 */
export function meetingTurns(stdin) {
  const m = /<meeting_transcript>\n?([\s\S]*?)\n?<\/meeting_transcript>/.exec(stdin);
  const turns = [];
  for (const line of (m ? m[1] : '').split('\n')) {
    const t = /^\[(\d\d:\d\d)\] (.*?): (.*)$/.exec(line);
    if (t) turns.push({ at: t[1], speaker: t[2], text: t[3].replace(/<\\\//g, '</') });
  }
  return turns;
}

/** Meetings mode's answer: the summary JSON (or what a mode makes of it) as the result text. */
function meetingResultFor(mode, stdin) {
  if (mode === 'auth-error' || mode === 'empty') return resultFor(mode, '');
  const turns = meetingTurns(stdin);
  const marker = /MEET-MARKER-[0-9a-z]+/.exec(stdin)?.[0];
  const marked = (text) => (marker ? `${text} ${marker}` : text);
  const speakers = [...new Set(turns.map((t) => t.speaker))];
  const first = speakers[0] ?? 'Nobody';
  const notes = {
    summary: marked(`${first} opened the meeting; ${turns.length} lines were said.`),
    decisions: [marked('Launch moves to Friday.'), 'Keep the current hosting.'],
    actionItems: [
      { title: marked('Send the revised quote'), owner: first.slice(0, 60) },
      { title: 'Book the review room', owner: (speakers[1] ?? first).slice(0, 60) },
    ],
  };
  const json = JSON.stringify(notes);
  switch (mode) {
    case 'meeting-fence':
      return { result: `\`\`\`json\n${json}\n\`\`\`` };
    case 'meeting-bad-json':
      return { result: json.slice(0, -5), stderr: `fake claude: notes cut short after: ${turns[0]?.text ?? ''}\n` };
    case 'meeting-too-many':
      return { result: JSON.stringify({ ...notes, actionItems: Array.from({ length: 31 }, (_, i) => ({ title: `Task ${i + 1}` })) }) };
    case 'meeting-long':
      return { result: JSON.stringify({ ...notes, summary: 's'.repeat(2001) }) };
    case 'meeting-answer':
      return { result: `${first} talked about the launch, and the team agreed to move it to Friday.` };
    default:
      return { result: json };
  }
}

/** Ask's stdin: today and now from <now>, and the message with the daemon's tag escapes undone. */
export function askParts(stdin) {
  const today = /^Today: \w{3} (\d{4}-\d{2}-\d{2})$/m.exec(stdin)?.[1] ?? '2026-01-15';
  const now = /^Time: (\d{2}:\d{2})/m.exec(stdin)?.[1] ?? '00:00';
  const m = /<message>\n?([\s\S]*?)\n?<\/message>/.exec(stdin);
  const message = (m ? m[1] : stdin).replace(/<\\(\/?)/g, '<$1').trim();
  return { today, now, message };
}

/** A day key `n` days after `day`. */
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const hhmm = (h, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** ask-ok's answer for one message (see the file comment). */
export function askOkAnswer({ today, now, message }) {
  const reply = (what) => `${what} For: ${message}`;
  let m;
  if ((m = /^todo add (.+)$/is.exec(message))) {
    return { reply: reply('A todo.'), actions: [{ type: 'todo', title: m[1] }] };
  }
  if ((m = /^remind me every day at (\d{1,2}):(\d{2}) to (.+)$/is.exec(message))) {
    return { reply: reply('A reminder every day.'), actions: [{ type: 'todo', title: m[3], time: hhmm(Number(m[1]), Number(m[2])), repeat: 'daily' }] };
  }
  if ((m = /^remind me to (.+?)( tomorrow)? at (\d{1,2}):(\d{2})$/is.exec(message))) {
    const day = m[2] ? addDays(today, 1) : today;
    return { reply: reply('A reminder.'), actions: [{ type: 'todo', title: m[1], day, time: hhmm(Number(m[3]), Number(m[4])) }] };
  }
  if ((m = /^remind me at (\d{1,2}) to (.+)$/is.exec(message))) {
    // The prompt's "at 6" rule: the next 6 o'clock still ahead.
    const h = Number(m[1]);
    const title = m[2].replace(/^take /i, 'Take ');
    const [day, time] = hhmm(h) > now ? [today, hhmm(h)] : h + 12 < 24 && hhmm(h + 12) > now ? [today, hhmm(h + 12)] : [addDays(today, 1), hhmm(h)];
    return { reply: reply('A reminder.'), actions: [{ type: 'todo', title, day, time }] };
  }
  if (/^had 2 rotis and dal\b/i.test(message)) {
    return {
      reply: reply('Assumed 2 medium rotis and 1 bowl of dal.'),
      actions: [
        { type: 'food', name: 'Roti', kcal: 240 },
        { type: 'food', name: 'Dal', kcal: 180 },
      ],
    };
  }
  if ((m = /^(?:ate|had) (.+?)(?: (\d+) kcal)?$/is.exec(message))) {
    return { reply: reply('One food.'), actions: [{ type: 'food', name: m[1], kcal: m[2] ? Number(m[2]) : 100 }] };
  }
  if ((m = /^spent (\d+(?:\.\d+)?) on (.+)$/is.exec(message))) {
    return { reply: reply('An expense.'), actions: [{ type: 'money', kind: 'expense', amount: Number(m[1]), category: 'food', note: m[2] }] };
  }
  if (/calories left/i.test(message)) return { reply: reply('Here are your calories.'), actions: [{ type: 'show', what: 'calories' }] };
  if (/what'?s due/i.test(message)) return { reply: reply("Here is what's due."), actions: [{ type: 'show', what: 'due' }] };
  if (/\bmeds\b/i.test(message)) return { reply: reply("Here are today's medicines."), actions: [{ type: 'show', what: 'meds' }] };
  if ((m = /^(post|comment|reel|story|thread|short|video|link)(?: on (\S+))?( tomorrow)? (\d{1,2})(am|pm) about (.+)$/is.exec(message))) {
    const [, kind, where, tomorrow, h, half, about] = m;
    const platform = where?.startsWith('r/') ? 'reddit' : kind.toLowerCase() === 'thread' ? 'x' : 'instagram';
    const time = hhmm((Number(h) % 12) + (half.toLowerCase() === 'pm' ? 12 : 0));
    const post = { type: 'post', platform, kind: kind.toLowerCase(), ...(where ? { where } : {}), title: `About ${about}`, day: tomorrow ? addDays(today, 1) : today, time };
    return { reply: reply(`A ${kind.toLowerCase()} to post.`), actions: [post] };
  }
  return { reply: reply('Ask can suggest todos, reminders, food and money.'), actions: [] };
}

/** Ask mode's answer: the JSON (or what a mode makes of it) as the result text. */
function askResultFor(mode, stdin) {
  if (mode === 'auth-error' || mode === 'empty') return resultFor(mode, '');
  const parts = askParts(stdin);
  const { today } = parts;
  const json = JSON.stringify(askOkAnswer(parts));
  const todo = (title) => ({ type: 'todo', title });
  switch (mode) {
    case 'ask-fence':
      return { result: `\`\`\`json\n${json}\n\`\`\`` };
    case 'ask-bad-json':
      return { result: json.slice(0, -5), stderr: `fake claude: answer cut short after: ${parts.message}\n` };
    case 'ask-answer':
      return { result: `Sure, I would add that for you: ${parts.message}` };
    case 'ask-not-object':
      return { result: '[]' };
    case 'ask-unknown-type':
      return {
        result: JSON.stringify({
          reply: 'One todo.',
          actions: [
            todo('Call the bank'),
            { type: 'shell', command: 'touch x' },
            { type: 'settings', patch: { files: { enabled: true } } },
            { type: 'medicine', name: 'X', taken: true },
            { type: 'session', sid: 's1', text: 'y' },
            { type: 'intel', url: 'https://example.com' },
          ],
        }),
      };
    case 'ask-extra-field':
      return {
        result: JSON.stringify({
          reply: 'Four things.',
          actions: [
            { ...todo('Call the bank'), projectId: '01JFZ8X8Y3T0V5G9WQK2M4N6PR' },
            { ...todo('Pay rent'), id: '01JFZ8X8Y3T0V5G9WQK2M4N6PS' },
            { type: 'food', name: 'Roti', kcal: 120, save: true },
            { type: 'money', kind: 'expense', amount: 250, category: 'Food', billId: '01JFZ8X8Y3T0V5G9WQK2M4N6PT' },
          ],
        }),
      };
    case 'ask-too-many':
      return { result: JSON.stringify({ reply: 'Fifteen todos.', actions: Array.from({ length: 15 }, (_, i) => todo(`Task ${i + 1}`)) }) };
    case 'ask-bad-values':
      return {
        result: JSON.stringify({
          reply: 'Some of these are wrong.',
          actions: [
            { type: 'todo', title: 'Stretch', day: today, time: '00:00' },
            { type: 'todo', title: 'Water the plants', day: today, time: '00:00', repeat: 'weekly' },
            { type: 'money', kind: 'expense', amount: -5, category: 'Food' },
            { type: 'money', kind: 'expense', amount: '250', category: 'Food' },
            { type: 'food', name: 'Feast', kcal: 20000 },
            todo('x'.repeat(300)),
            todo(''),
            { type: 'todo', title: 'Leap', day: '2026-02-31' },
            { type: 'todo', title: 'Far away', day: addDays(today, 730) },
            { type: 'food', name: 'Roti', kcal: 120, day: addDays(today, 1) },
            { type: 'money', kind: 'expense', amount: 250, category: 'Food', day: addDays(today, 1) },
            { type: 'todo', title: 'Late', day: today, time: '25:00' },
            { type: 'todo', title: 'Often', day: today, repeat: 'hourly' },
            { type: 'show', what: 'spent' },
            { type: 'show', what: 'bills' },
          ],
        }),
      };
    case 'ask-long-reply': {
      const head = 'Here \u202Eis [bank](https://bank.example) \u0007a long reply. ';
      return { result: JSON.stringify({ reply: (head + 'x'.repeat(2000)).slice(0, 2000), actions: [] }) };
    }
    case 'ask-claims':
      return {
        result: JSON.stringify({ reply: 'Done! I added 50000 to your expenses.', actions: [{ type: 'money', kind: 'expense', amount: 50000, category: 'Other' }] }),
      };
    default:
      return { result: json };
  }
}

function resultFor(mode, text) {
  const clean = cleanText(text);
  switch (mode) {
    case 'auth-error':
      return { isError: true, subtype: 'error_during_execution', result: 'Invalid API key · Please run /login' };
    case 'empty':
      return { result: '' };
    case 'invent':
      return { result: `${clean} Also update \`src/new-file.ts\` and add tests.`.trim() };
    case 'answer': {
      // past the daemon's `expanded` guard (2.5 x the input + 300) for any input, and at least 3 x it
      const line = `Sure! Here's how I would do that: ${clean || 'start with the tests'}. `;
      const want = Math.max(3 * text.length, Math.ceil(2.5 * text.length) + 301, line.length);
      return { result: line.repeat(Math.ceil(want / line.length)).trim() };
    }
    case 'preface':
      return { result: `Here's the prompt: ${clean}` };
    case 'bang':
      return { result: '!rm -rf dist' };
    default:
      return { result: clean };
  }
}

let signalsWatched = false;

/**
 * Record SIGINT / SIGTERM from now on (call it before reading stdin, so a
 * cancel that comes early is still on record). The process then exits
 * 130 / 143, unless <root>/fake/claude.json `ignoreSignals` lists the signal.
 */
export function watchSignals(root) {
  if (signalsWatched) return;
  signalsWatched = true;
  const on = (signal, code) => () => {
    const ignored = (readJson(join(root, 'fake', 'claude.json'), {}).ignoreSignals || []).includes(signal);
    record(root, 'claude.signals.jsonl', { signal, pid: process.pid, ts: Date.now(), ...(ignored ? { ignored: true } : {}) });
    if (!ignored) process.exit(code);
  };
  process.on('SIGINT', on('SIGINT', 130));
  process.on('SIGTERM', on('SIGTERM', 143));
}

/** `bin`: the claude wrapper's path, or the claude cswap found on its PATH and would exec (never run: this fake answers). */
export async function runClaude({ root, args, stdin, account = null, via = 'claude', bin = process.argv[1] }) {
  watchSignals(root);
  record(root, 'claude.jsonl', { name: 'claude', args, stdin, cwd: process.cwd(), ...recordedEnv(CLAUDE_ENV_KEYS), ts: Date.now(), pid: process.pid, account, via, bin });

  const started = Date.now();
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${VERSION} (Claude Code)\n`);
    return 0;
  }
  if (!args.includes('-p') && !args.includes('--print')) {
    process.stderr.write('fake claude: only print mode (-p) is faked\n');
    return 1;
  }
  const format = optionValue(args, '--output-format') ?? 'text';
  const verbose = args.includes('--verbose');
  if (format === 'stream-json' && !verbose) {
    process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\n');
    return 1;
  }
  const promptFile = optionValue(args, '--system-prompt-file');
  if (promptFile !== undefined && !existsSync(resolve(promptFile))) {
    process.stderr.write(`Error: System prompt file not found: ${resolve(promptFile)}\n`);
    return 1;
  }
  const model = optionValue(args, '--model');
  const fallback = optionValue(args, '--fallback-model');
  if (fallback !== undefined && model !== undefined && fallback === model) {
    // claude's own check (its SDK words it this way; the CLI wording is unverified)
    process.stderr.write('Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n');
    return 1;
  }

  const config = readJson(join(root, 'fake', 'claude.json'), {});
  const food = promptFile !== undefined && promptFile.endsWith('estimate-v1.md');
  const meeting = promptFile !== undefined && promptFile.endsWith('summary-v1.md');
  const ask = promptFile !== undefined && /assistant-v\d+\.md$/.test(promptFile);
  const [modes, fallbackMode] = food
    ? [FOOD_MODES, 'food-ok']
    : meeting
      ? [MEETING_MODES, 'meeting-ok']
      : ask
        ? [ASK_MODES, 'ask-ok']
        : [MODES, 'clean'];
  const picked = pickMode(config, args, stdin, account, modes, fallbackMode);
  const delayMs = picked.rule?.delayMs ?? config.delayMs ?? 0;
  if (picked.rule && picked.rule.mode === undefined) {
    if (delayMs) await sleep(delayMs);
    if (picked.rule.stdout) process.stdout.write(picked.rule.stdout);
    if (picked.rule.stderr) process.stderr.write(picked.rule.stderr);
    return picked.rule.code ?? 0;
  }
  const mode = picked.rule ? (modes.includes(picked.rule.mode) ? picked.rule.mode : fallbackMode) : picked.mode;

  if ((mode === 'unknown-option' || mode === 'food-refuse-option' || mode === 'ask-refuse-option') && args.includes('--permission-prompts')) {
    process.stderr.write("error: unknown option '--permission-prompts'\n");
    return 1;
  }
  if (delayMs) await sleep(delayMs);
  if (mode === 'slow') await sleep(Number(process.env.FAKE_CLAUDE_SLOW_MS) || config.slowMs || DEFAULT_SLOW_MS);

  const input = optionValue(args, '--input-format') === 'stream-json' ? streamJsonText(stdin) : stdin;
  const text = dictatedText(input);
  const out = food ? foodResultFor(mode, mealText(input)) : meeting ? meetingResultFor(mode, input) : ask ? askResultFor(mode, input) : resultFor(mode, text);
  if (out.stderr) process.stderr.write(out.stderr);
  const modelName = model ?? 'default';
  const sessionId = optionValue(args, '--session-id') ?? randomUUID();
  const inputTokens = Math.ceil(input.length / 4);
  const outputTokens = Math.ceil(out.result.length / 4);
  const durationMs = Date.now() - started + 850;
  const result = {
    type: 'result',
    subtype: out.subtype ?? 'success',
    is_error: out.isError ?? false,
    duration_ms: durationMs,
    duration_api_ms: durationMs - 50,
    ttft_ms: 400,
    num_turns: 1,
    result: out.result,
    session_id: sessionId,
    total_cost_usd: out.isError ? 0 : 0.0042,
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2048,
      output_tokens: outputTokens,
      service_tier: 'standard',
    },
    modelUsage: { [modelName]: { inputTokens, outputTokens, cacheReadInputTokens: 2048, cacheCreationInputTokens: 0, costUSD: 0.0042 } },
    permission_denials: [],
    uuid: randomUUID(),
  };
  const messages = [
    { type: 'system', subtype: 'init', session_id: sessionId, model: modelName, tools: [], mcp_servers: [], cwd: process.cwd() },
    ...(mode === 'rate-limit'
      ? [{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: 'rate_limit', session_id: sessionId }]
      : []),
    ...(out.isError
      ? []
      : [{ type: 'assistant', message: { role: 'assistant', model: modelName, content: [{ type: 'text', text: out.result }] }, session_id: sessionId }]),
    result,
  ];

  if (format === 'json') process.stdout.write(`${JSON.stringify(verbose ? messages : result)}\n`);
  else if (format === 'stream-json') for (const m of messages) process.stdout.write(`${JSON.stringify(m)}\n`);
  else process.stdout.write(`${out.result}\n`);
  return out.isError ? 1 : 0;
}
