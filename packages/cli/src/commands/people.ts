/**
 * jantar people (v0.11, spec 9.5): the Accountability partner space on this
 * Mac (People in the code, the routes and this command's name), at the Mac
 * (ctl.sock). Every command that lets a person in, shapes what they are
 * offered or ends their space runs here only (`localOnly` routes):
 *
 *   people on [--name <your name>] | off
 *   people doctor
 *   people add <name> [--email <addr>] [--color <c>] [--no-food] [--label <words>]
 *   people label <name|id> [<words> | --default]   (no words: print it)
 *   people offer <name|id> [--preset light|standard|everything]
 *                [--see todos,plan,review=counts|full,meds=full|adherence,weight,food=counts|full,sleep,journal,chat]
 *                [--assign todos,plan,meds] [--edit-hers todos,plan,meds,weight] [--comment journal]
 *   people ask <name|id> [--see ...] [--assign ...] [--edit-hers ...] [--comment ...] [--note <text>]
 *   people prefs [--summary HH:MM|off] [--review-push on|off] [--quiet HH:MM-HH:MM|off]
 *   people modules <name|id> --food on|off
 *   people invite <name|id> [--json]      (needs your name: people on --name)
 *   people list
 *   people devices <name|id>
 *   people revoke <device-id>
 *   people revoke-invite <name|id>
 *   people remove <name|id> [--now] [--forget]
 *   people todos <name|id>
 *
 * A label (what the space with them is called: "Cofounder", "Coach", or
 * words of his own) is plain text on one line, so it can carry no terminal
 * escape. Nothing here prints a last-seen, an address or a user agent of theirs
 * (C20), nor any text of their journal, comments, chat or sleep (O15).
 * Adding or removing an email prints the Cloudflare Access step: Jantar
 * holds no Cloudflare token and can't make that change.
 */
import type { Settings } from '@jantar/protocol';
import { PEOPLE_LABEL, PERSON_LABEL_PRESETS, personLabelProblem, spaceLabel } from '@jantar/protocol/people-core';
import type { OwnerPeoplePrefs, PeopleDoctor, PeopleList, PersonInviteReply, PersonSetupAgain, PersonView } from '@jantar/protocol/people';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';
import { localBaseUrl } from '../lib/settings.js';
import { localStatus, probeUrl } from '../lib/doctor.js';
import { clean } from '../lib/text.js';

const USAGE = 'jantar people <on|off|doctor|add|label|offer|ask|prefs|modules|invite|list|devices|revoke|revoke-invite|remove|todos> ...';

const FIELD_GROUPS = ['see', 'assign', 'editHers', 'comment'] as const;

/** What `invite` says while the owner's name is unset: their page and app show it. */
export const NAME_FIRST = 'Set your name first: jantar people on --name <your name>. Their join page and app show it.';

/**
 * `todos,meds=adherence,food=counts,weight=off` into a patch of one group (a bare name is on; `x=off` turns it
 * off). The fields with levels (meds, review, food) take their level, a bare name or `on` meaning full.
 */
export function fieldList(group: (typeof FIELD_GROUPS)[number], value: string | undefined): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {};
  if (!value) return out;
  for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, level] = part.split('=') as [string, string | undefined];
    if (!/^[a-z]+$/i.test(name)) throw new UsageError(`"${part}" is not a field`);
    if (group === 'see' && (name === 'meds' || name === 'review' || name === 'food')) out[name] = level === undefined || level === 'on' ? 'full' : level === 'false' ? 'off' : level;
    else out[name] = level === undefined ? true : level !== 'off' && level !== 'false';
  }
  return out;
}

/** The `--see`, `--assign`, `--edit-hers` and `--comment` flags as an agreement patch (offer and ask). */
export function fieldPatch(flags: { see?: string; assign?: string; 'edit-hers'?: string; comment?: string }): Record<string, Record<string, boolean | string>> {
  const out: Record<string, Record<string, boolean | string>> = {};
  const groups: Array<[(typeof FIELD_GROUPS)[number], string | undefined]> = [
    ['see', flags.see],
    ['assign', flags.assign],
    ['editHers', flags['edit-hers']],
    ['comment', flags.comment],
  ];
  for (const [group, value] of groups) {
    const g = fieldList(group, value);
    if (Object.keys(g).length) out[group] = g;
  }
  return out;
}

/** One line of `people doctor`: a check (ok or FIX) or a note to act on by hand. */
export interface HostCheck {
  name: string;
  ok: boolean;
  detail: string;
  note?: true;
}

/** What jantard must answer on this Mac for a request through her hostname, and for one through his (spec 2.1 step 4, C15). */
export const FENCE: ReadonlyArray<{ on: 'hers' | 'his'; path: string; want: number; what: string }> = [
  { on: 'hers', path: '/p', want: 200, what: 'her app' },
  { on: 'hers', path: '/v1/state', want: 404, what: 'his board' },
  { on: 'hers', path: '/index.html', want: 404, what: 'his app' },
  { on: 'hers', path: '/sw.js', want: 404, what: "his app's service worker" },
  { on: 'hers', path: '/v1/node/link', want: 404, what: "Fleet's link" },
  { on: 'his', path: '/v1/p/me', want: 404, what: 'her routes' },
];

/**
 * The Origin half of the fence, checked with no credential (C1): a write carrying the other host's Origin is
 * refused before anything else runs. On his host, the public pairing claim with her Origin is a 403 (with
 * his own Origin it is a 400: no body, so nothing is claimed, limited or audited). On her host, the join
 * preview with his Origin is a 403 before her claim limiter counts it (People off: her join routes are 404).
 * His other writes and her routes past joining ask for a device first (401), which needs a credential.
 */
export const ORIGIN_FENCE: ReadonlyArray<{ on: 'hers' | 'his'; path: string; origin: 'hers' | 'his'; want: number; what: string }> = [
  { on: 'his', path: '/v1/pair/claim', origin: 'hers', want: 403, what: 'a write of yours with their Origin' },
  { on: 'his', path: '/v1/pair/claim', origin: 'his', want: 400, what: 'the same write with your Origin' },
  { on: 'hers', path: '/v1/p/join/preview', origin: 'his', want: 403, what: 'a write of theirs with your Origin' },
];

/**
 * `people doctor`'s checks past the daemon's own (spec 2.1 step 4): with her hostname set,
 * - the host fence, on this Mac: through her Host jantard serves her app and none of his (his board, app,
 *   service worker, Fleet's link), and through his none of her routes;
 * - the Origin half of it (ORIGIN_FENCE), with no credential: each host refuses a write with the other's
 *   Origin;
 * - in cloudflare mode, Access in front of her hostname: a credential-less GET of /healthz must be sent to
 *   Cloudflare Access sign-in (*.cloudflareaccess.com), never answered;
 * - in tailscale mode, the policy step Jantar can't check (a note).
 */
export async function peopleHostChecks(ctx: CliContext, settings: Settings): Promise<HostCheck[]> {
  const url = settings.remote.peopleUrl;
  if (!url) return [];
  let her: URL;
  try {
    her = new URL(url);
  } catch {
    return [];
  }
  const out: HostCheck[] = [];
  const base = localBaseUrl(settings);
  const get = ctx.deps.localStatus ?? localStatus;
  const his = settings.remote.publicUrl ? new URL(settings.remote.publicUrl).host : new URL(base).host;
  const wrong: string[] = [];
  let answered = false;
  for (const f of FENCE) {
    const status = await get(base, f.path, f.on === 'hers' ? her.host : his);
    if (status === null) continue;
    answered = true;
    if (status !== f.want) wrong.push(`${f.on === 'hers' ? her.host : his}${f.path} (${f.what}) answered ${status}, not ${f.want}`);
  }
  if (!answered) out.push({ name: 'host fence', ok: false, detail: `jantard doesn't answer on ${base}: is it running? (jantar status)` });
  else out.push({ name: 'host fence', ok: wrong.length === 0, detail: wrong.length === 0 ? `${her.host} serves her app and none of yours; yours serves none of hers` : wrong.join('; ') });
  if (answered) {
    const hisOrigin = settings.remote.publicUrl ? new URL(settings.remote.publicUrl).origin : new URL(base).origin;
    const off = !settings.people.enabled;
    const leaks: string[] = [];
    for (const o of ORIGIN_FENCE) {
      const host = o.on === 'hers' ? her.host : his;
      const status = await get(base, o.path, host, { method: 'POST', origin: o.origin === 'hers' ? her.origin : hisOrigin });
      // People off: her join routes don't exist (404), which refuses every Origin.
      const want = off && o.on === 'hers' ? 404 : o.want;
      if (status !== want) leaks.push(`${host}${o.path} (${o.what}) answered ${status ?? 'nothing'}, not ${want}`);
    }
    out.push({
      name: 'origin fence',
      ok: leaks.length === 0,
      detail: leaks.length === 0 ? `${his} refuses writes with ${her.origin}'s Origin, and ${her.host} with ${hisOrigin}'s` : leaks.join('; '),
    });
  }
  if (settings.remote.mode === 'cloudflare') {
    const r = await (ctx.deps.probe ?? probeUrl)(`${her.origin}/healthz`);
    let to = '';
    try {
      to = r?.location ? new URL(r.location, her.origin).hostname : '';
    } catch {
      to = '';
    }
    if (r === null) {
      out.push({ name: 'Access in front', ok: false, detail: `nothing answers at ${her.origin}: check its DNS route and the tunnel's ingress rule (docs/people.md#their-hostname)` });
    } else if (r.status >= 300 && r.status < 400 && to.endsWith('.cloudflareaccess.com')) {
      out.push({ name: 'Access in front', ok: true, detail: `${her.host} sends a visitor without a sign-in to Cloudflare Access` });
    } else {
      out.push({ name: 'Access in front', ok: false, detail: `Access isn't protecting ${her.host}: it answered ${r.status}${to ? ` (to ${to})` : ''} without a sign-in. Add an Access application for it (docs/people.md#their-hostname)` });
    }
  } else if (settings.remote.mode === 'tailscale') {
    out.push({
      name: 'Tailscale policy',
      ok: true,
      note: true,
      detail: `share this Mac with their tailnet account and grant it ${her.host}'s port only, nothing else on the Mac (docs/people.md#tailscale)`,
    });
  }
  return out;
}

/** The owner's name as their page shows it, or null while unset. */
async function ownerName(ctx: CliContext): Promise<string | null> {
  const r = await callDaemon<{ settings: { people?: { ownerName?: string | null } } }>(ctx.ctl, 'GET', '/v1/settings');
  return r.settings.people?.ownerName ?? null;
}

function hhmm(v: string, flag: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new UsageError(`${flag} needs HH:MM (24-hour), or off`);
  return v;
}

function onOff(v: string, flag: string): boolean {
  if (v !== 'on' && v !== 'off') throw new UsageError(`${flag} needs on or off`);
  return v === 'on';
}

function quiet(v: string): { from: string; to: string } {
  const [from, to] = v.split('-');
  if (!from || !to) throw new UsageError('--quiet needs HH:MM-HH:MM, or off');
  return { from: hhmm(from, '--quiet'), to: hhmm(to, '--quiet') };
}

async function find(ctx: CliContext, who: string): Promise<PersonView> {
  const list = await callDaemon<PeopleList>(ctx.ctl, 'GET', '/v1/people');
  // By name, someone still in the space wins over someone who left with the same name (their id reaches either).
  const named = list.people.filter((p) => p.name.toLowerCase() === who.toLowerCase());
  const hit = list.people.find((p) => p.id === who) ?? named.find((p) => p.state !== 'left') ?? named[0];
  if (!hit) throw new UsageError(`no person "${clean(who)}" (see: jantar people list)`);
  // Their name is theirs to write (their join): every line that names them prints it through clean().
  return { ...hit, name: clean(hit.name) };
}

function accessStep(email: string | undefined, add: boolean): string {
  const who = email ?? 'their email';
  return add
    ? `In Zero Trust > Access > Applications > Accountability partner > Policies > Partner > Include > Emails, add ${who}, then Save. Jantar holds no Cloudflare token and can't do this for you.\n`
    : `In Zero Trust > Access > Applications > Accountability partner > Policies > Partner, remove ${who}. Optionally, My Team > Users > them > Revoke session.\n`;
}

/** A label from the command line, trimmed and checked here first (the daemon checks it again). */
function labelArg(v: string): string {
  const problem = personLabelProblem(v);
  if (problem) throw new UsageError(`${problem} Presets: ${PERSON_LABEL_PRESETS.join(', ')}; or words of your own.`);
  return v.trim();
}

/** The Access step for a remove with the 7-day window: only once it ends, or Access shuts them out of the download their page promises. */
function accessStepAfter(email: string | undefined, until: string | undefined): string {
  const who = email ?? 'their email';
  return `After ${until ?? 'the 7 days'}, in Zero Trust > Access > Applications > Accountability partner > Policies > Partner, remove ${who}. Not before: until then Access must let them in to download their data.\n`;
}

/** T20 (spec 2.7): a space a Life restore took out, and the way back (his People screen says the same). */
export function setupAgainNote(s0: PersonSetupAgain): string {
  const s = s0.accessEmail ? { ...s0, accessEmail: clean(s0.accessEmail) } : s0;
  const email = s.accessEmail ? ` --email ${s.accessEmail}` : '';
  return (
    `  Restore removed ${s.accessEmail ? `the space you shared with ${s.accessEmail}` : 'the space you shared'}. Invite them again.  ${s.id}\n` +
    `    jantar people add <name>${email}, then jantar people invite <name>.\n` +
    `    Once they have joined: jantar people remove ${s.id} clears this. A newer backup that still has their space brings sharing back instead.\n`
  );
}

const ON_WORDS: Record<string, string> = {
  'see.todos': 'sees their to-dos and reminders',
  'see.meds': 'sees their medicines',
  'see.weight': 'sees their weight',
  'see.food': 'sees their food log: how many meals at counts; what they ate, with calories, at full',
  'assign.todos': 'adds to-dos and reminders for them',
  'assign.meds': 'adds medicines for them',
  'editHers.todos': 'edits or removes to-dos they added',
  'editHers.meds': 'edits or stops medicines they added',
  'editHers.weight': 'corrects or removes a weight they logged',
  'see.plan': 'sees their day plan, check-ins and status',
  'see.review': 'sees their evening review',
  'see.sleep': 'sees their sleep, as they tap it',
  'see.journal': 'reads their journal',
  'see.chat': 'reads their chats with their assistant',
  'assign.plan': 'plans their day',
  'editHers.plan': 'edits or removes plan steps they added',
  'comment.journal': 'comments on their journal entries',
};

export default defineCommand(
  {
    name: 'people',
    summary: `${PEOPLE_LABEL}: share a space on this Mac with one other person (invite, the offer, devices, remove).`,
    usage: USAGE,
    owner: 'WP-PEOPLE',
    help:
      `  people on [--name <your name>] | off      turn ${PEOPLE_LABEL} on (their exits always work) or off\n` +
      '  people add <name> [--email <addr>] [--no-food] [--label <words>]\n' +
      `  people label <name> [<words> | --default]  what the space with them is called (${PERSON_LABEL_PRESETS.join(', ')}, or your words)\n` +
      '  people offer <name> [--preset light|standard|everything] [--see ...] [--assign ...] [--edit-hers ...] [--comment journal]\n' +
      '      --see todos,plan,review=counts|full,meds=full|adherence,weight,food=counts|full,sleep,journal,chat (x=off turns one off)\n' +
      '      --assign todos,plan,meds   --edit-hers todos,plan,meds,weight   --comment journal\n' +
      '  people ask <name> [--see ...] [--assign ...] [--edit-hers ...] [--comment ...] [--note <text>]\n' +
      '                                            ask them for more; nothing changes until they accept\n' +
      '  people prefs [--summary HH:MM|off] [--review-push on|off] [--quiet HH:MM-HH:MM|off]\n' +
      '                                            your pushes about them (the day summary is off until you set a time)\n' +
      '  people invite <name> [--json]             a 24-hour, single-use join link (needs your name)\n' +
      '  people list | devices <name> | todos <name>\n' +
      '  people revoke <device-id> | revoke-invite <name> | remove <name> [--now] [--forget]\n' +
      '  people modules <name> --food on|off       their food log (off is refused while they have entries) | doctor',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(
      argv,
      {
        name: { type: 'string', help: 'your name, as they read it' },
        email: { type: 'string', help: 'their email (a reminder for the Access step)' },
        color: { type: 'string', help: 'teal, violet, amber, rose, sky or lime' },
        food: { type: 'string', help: 'on or off (modules: their food log); --no-food on add' },
        preset: { type: 'string', help: 'light, standard (default) or everything' },
        see: { type: 'string', help: 'todos,plan,review=counts|full,meds=full|adherence|off,weight,food=counts|full|off,sleep,journal,chat' },
        assign: { type: 'string', help: 'todos,plan,meds' },
        'edit-hers': { type: 'string', help: 'todos,plan,meds,weight' },
        comment: { type: 'string', help: 'journal' },
        note: { type: 'string', help: 'a short note with ask (up to 200 characters)' },
        summary: { type: 'string', help: 'prefs: HH:MM for the day summary, or off' },
        'review-push': { type: 'string', help: 'prefs: on or off' },
        quiet: { type: 'string', help: 'prefs: HH:MM-HH:MM, or off' },
        json: { type: 'boolean', help: 'print JSON' },
        now: { type: 'boolean', help: 'end sharing at once (no 7-day window)' },
        forget: { type: 'boolean', help: 'delete their space at once' },
        'no-food': { type: 'boolean', help: 'add them without a food log' },
        label: { type: 'string', help: `add: what the space with them is called (default "${PEOPLE_LABEL}")` },
        default: { type: 'boolean', help: `label: back to "${PEOPLE_LABEL}"` },
        qr: { type: 'boolean', help: 'accepted for compatibility (the link is printed)' },
      },
      { min: 1, max: 3 },
    );
    const [action, who, extra] = positionals;
    if (extra !== undefined && action !== 'label') throw new UsageError(`${action} takes one name (quote a name with spaces)`);
    const io = ctx.io;
    const need = (what: string) => {
      if (!who) throw new UsageError(`${action} needs ${what}`);
      return who;
    };
    switch (action) {
      case 'on': {
        if (flags.name) {
          const r = await callDaemon<{ settings?: unknown }>(ctx.ctl, 'PATCH', '/v1/settings', { people: { ownerName: flags.name } });
          void r;
        }
        await callDaemon(ctx.ctl, 'POST', '/v1/people/switch', { on: true });
        io.out(`${PEOPLE_LABEL} is on.\n`);
        if (!flags.name && (await ownerName(ctx)) === null) io.out(`${NAME_FIRST}\n`);
        return EXIT.ok;
      }
      case 'off':
        await callDaemon(ctx.ctl, 'POST', '/v1/people/switch', { on: false });
        io.out(`${PEOPLE_LABEL} is off. They can still download their data or leave.\n`);
        return EXIT.ok;
      case 'doctor': {
        const d = await callDaemon<PeopleDoctor>(ctx.ctl, 'GET', '/v1/people/doctor');
        const settings = (await callDaemon<{ settings: Settings }>(ctx.ctl, 'GET', '/v1/settings')).settings;
        const checks: HostCheck[] = [...d.checks, ...(await peopleHostChecks(ctx, settings))];
        // Their name is in the food lines: printed through clean(), like every word of theirs here.
        for (const c of checks) io.out(`${c.note ? 'note' : c.ok ? 'ok  ' : 'FIX '} ${clean(c.name)}: ${clean(c.detail)}\n`);
        return checks.every((c) => c.ok) ? EXIT.ok : EXIT.failed;
      }
      case 'add': {
        const name = need('a name');
        const body = {
          name,
          ...(flags.email ? { email: flags.email } : {}),
          ...(flags.color ? { color: flags.color } : {}),
          ...(flags.label !== undefined ? { label: labelArg(flags.label) } : {}),
          modules: { food: !flags['no-food'] && flags.food !== 'off' },
        };
        const r = await callDaemon<{ id: string }>(ctx.ctl, 'POST', '/v1/people', body);
        io.out(`Added ${name} (${r.id}). No invite yet.\n`);
        io.out(`Their space is called "${spaceLabel(body.label)}" on your screens and theirs (change it: jantar people label ${name} <words>).\n`);
        io.out(accessStep(flags.email, true));
        io.out(`Next: jantar people offer ${name} (optional), then jantar people invite ${name}\n`);
        return EXIT.ok;
      }
      case 'label': {
        const p = await find(ctx, need('a person'));
        if (extra === undefined && !flags.default) {
          io.out(`${p.name}: "${clean(spaceLabel(p.label))}"\n`);
          return EXIT.ok;
        }
        if (extra !== undefined && flags.default) throw new UsageError('label takes words or --default, not both');
        const label = flags.default ? null : labelArg(extra as string);
        await callDaemon(ctx.ctl, 'PATCH', `/v1/people/${p.id}`, { label });
        io.out(`The space with ${p.name} is now called "${spaceLabel(label)}".${p.state === 'active' || p.state === 'paused' ? ' Their app shows it now, and their Activity says you renamed it.' : ''}\n`);
        io.out('Their Home Screen keeps the name it was added with; the new name shows inside the app.\n');
        return EXIT.ok;
      }
      case 'offer': {
        const p = await find(ctx, need('a person'));
        const body: Record<string, unknown> = {};
        if (flags.preset) body.preset = flags.preset;
        Object.assign(body, fieldPatch(flags));
        const r = await callDaemon<{ version: number; on: string[]; fields: Record<string, Record<string, unknown>> }>(ctx.ctl, 'POST', `/v1/people/${p.id}/offer`, body);
        if (flags.json) {
          io.out(`${JSON.stringify(r)}\n`);
          return EXIT.ok;
        }
        io.out(`Offer v${r.version} for ${p.name} (what you would see and do):\n`);
        for (const [group, fields] of Object.entries(r.fields)) {
          if (typeof fields !== 'object' || fields === null) continue;
          for (const [k, v] of Object.entries(fields)) {
            const key = `${group}.${k}`;
            if (!(key in ON_WORDS) && v === false) continue;
            io.out(`  ${key} = ${String(v)}${v !== false && v !== 'off' && ON_WORDS[key] ? `  (${ON_WORDS[key]})` : ''}\n`);
          }
        }
        return EXIT.ok;
      }
      case 'modules': {
        const p = await find(ctx, need('a person'));
        if (flags.food !== 'on' && flags.food !== 'off') throw new UsageError('modules needs --food on or --food off');
        await callDaemon(ctx.ctl, 'PATCH', `/v1/people/${p.id}/modules`, { food: flags.food === 'on' });
        // What they agreed to after the change (food on grants nothing, and puts off a level they never saw).
        const after = await find(ctx, p.id).catch(() => null);
        const level = after?.agreement?.see.food ?? 'off';
        if (flags.food === 'off') {
          io.out(`${p.name}'s food log is off: their app has no Food, and you see none of it.\n`);
          return EXIT.ok;
        }
        io.out(`${p.name}'s food log is on: their app has Food, and a quick add on Today.\n`);
        // Turning it on grants nothing (D24): what you see of it is what they agreed to.
        if (p.state === 'invited') io.out(`Their invite offers it as the offer says: jantar people offer ${p.name} --see food=counts|full\n`);
        else if (level === 'off') io.out(`You see none of it until they say yes: jantar people ask ${p.name} --see food=counts (how many meals) or food=full (what they ate, with calories)\n`);
        else io.out(`You see ${level === 'full' ? 'what they eat, with calories' : 'how many meals they log'}, as they agreed.\n`);
        return EXIT.ok;
      }
      case 'ask': {
        const p = await find(ctx, need('a person'));
        const body: Record<string, unknown> = fieldPatch(flags);
        if (Object.keys(body).length === 0) throw new UsageError('ask needs --see, --assign, --edit-hers or --comment');
        if (flags.note) body.note = flags.note;
        await callDaemon(ctx.ctl, 'POST', `/v1/people/${p.id}/agreement`, body);
        io.out(`Asked ${p.name}. Nothing changes until they accept; they can also say no, or not to ask again.\n`);
        return EXIT.ok;
      }
      case 'prefs': {
        const body: Record<string, unknown> = {};
        if (flags.summary !== undefined) body.summaryAt = flags.summary === 'off' ? null : hhmm(flags.summary, '--summary');
        if (flags['review-push'] !== undefined) body.reviewPush = onOff(flags['review-push'], '--review-push');
        if (flags.quiet !== undefined) body.quiet = flags.quiet === 'off' ? null : quiet(flags.quiet);
        const r = await callDaemon<{ prefs: OwnerPeoplePrefs }>(ctx.ctl, 'PATCH', '/v1/people/prefs', body);
        const q = r.prefs.quiet;
        io.out(`Day summary: ${r.prefs.summaryAt ?? 'off'}\n`);
        io.out(`Evening review push: ${r.prefs.reviewPush ? 'on' : 'off'}\n`);
        io.out(`Quiet hours for pushes about them: ${q ? `${q.from}-${q.to}` : 'off'}\n`);
        return EXIT.ok;
      }
      case 'invite': {
        const p = await find(ctx, need('a person'));
        if ((await ownerName(ctx)) === null) {
          io.err(`${NAME_FIRST}\n`);
          return EXIT.failed;
        }
        const r = await callDaemon<PersonInviteReply>(ctx.ctl, 'POST', `/v1/people/${p.id}/invite`);
        if (flags.json) {
          io.out(`${JSON.stringify(r)}\n`);
          return EXIT.ok;
        }
        io.out(`Send ${p.name} this link (it works once, until ${r.expiresAt}):\n\n  ${r.url}\n\n`);
        io.out('The link alone gets nobody in without the Access policy letting their email through.\n');
        // 0.12.1: Access's One-time PIN form keeps only the path, so the #c= is gone after they sign in.
        io.out("With Access's One-time PIN, signing in drops the part of the link that holds the invite: after signing in they open the link once more, or paste it on the page. An identity provider like Google keeps the link whole.\n");
        return EXIT.ok;
      }
      case 'list': {
        const r = await callDaemon<PeopleList>(ctx.ctl, 'GET', '/v1/people');
        if (flags.json) {
          io.out(`${JSON.stringify(r)}\n`);
          return EXIT.ok;
        }
        io.out(`${PEOPLE_LABEL} is ${r.enabled ? 'on' : 'off'}.\n`);
        const again = r.setupAgain ?? [];
        if (r.people.length === 0 && again.length === 0) io.out('Nobody yet. Add someone: jantar people add <name> --email <address>\n');
        for (const p of r.people) {
          const note = p.state === 'invited' && p.invite ? ` (link until ${p.invite.expiresAt})` : p.state === 'ending' && p.endingUntil ? ` (until ${p.endingUntil})` : '';
          const named = spaceLabel(p.label) === PEOPLE_LABEL ? '' : ` (${clean(spaceLabel(p.label))})`;
          io.out(`  ${clean(p.name)}${named}  ${p.state}${note}  ${p.id}\n`);
        }
        for (const s of again) io.out(setupAgainNote(s));
        return EXIT.ok;
      }
      case 'devices': {
        const p = await find(ctx, need('a person'));
        const r = await callDaemon<{ devices: { id: string; name: string; createdAt: string; accessEmail?: string; revokedAt?: string }[] }>(ctx.ctl, 'GET', `/v1/people/${p.id}/devices`);
        for (const d of r.devices) io.out(`  ${d.id}  ${clean(d.name)}  added ${d.createdAt.slice(0, 10)}${d.accessEmail ? `  ${clean(d.accessEmail)}` : ''}${d.revokedAt ? '  (revoked)' : ''}\n`);
        if (r.devices.length === 0) io.out('No devices yet.\n');
        return EXIT.ok;
      }
      case 'revoke': {
        const did = need('a device id (see: jantar people devices <name>)');
        const list = await callDaemon<PeopleList>(ctx.ctl, 'GET', '/v1/people');
        for (const p of list.people) {
          const r = await callDaemon<{ devices: { id: string }[] }>(ctx.ctl, 'GET', `/v1/people/${p.id}/devices`).catch(() => ({ devices: [] }));
          if (r.devices.some((d) => d.id === did)) {
            await callDaemon(ctx.ctl, 'DELETE', `/v1/people/${p.id}/devices/${did}`);
            io.out(`Revoked ${clean(did)}. ${clean(p.name)}'s other devices were told.\n`);
            return EXIT.ok;
          }
        }
        io.err(`No device ${did}. See: jantar people devices <name>\n`);
        return EXIT.failed;
      }
      case 'revoke-invite': {
        const p = await find(ctx, need('a person'));
        await callDaemon(ctx.ctl, 'DELETE', `/v1/people/${p.id}/invite`);
        io.out(`${p.name}'s unspent link no longer works.\n`);
        return EXIT.ok;
      }
      case 'remove': {
        const target = need('a person');
        // T20: someone whose space a restore took out is in no list by name; their id clears the note (no window: nothing is left to download).
        const again = (await callDaemon<PeopleList>(ctx.ctl, 'GET', '/v1/people')).setupAgain?.find((s) => s.id === target);
        if (again) {
          await callDaemon(ctx.ctl, 'POST', `/v1/people/${again.id}/remove`, { mode: 'now', forget: Boolean(flags.forget) });
          // No Access step: they may be sharing again under a new invite with the same email.
          io.out(`Cleared ${again.id}: its old devices no longer open anything.\n`);
          return EXIT.ok;
        }
        const p = await find(ctx, target);
        await callDaemon(ctx.ctl, 'POST', `/v1/people/${p.id}/remove`, { mode: flags.now ? 'now' : 'window', forget: Boolean(flags.forget) });
        // What the daemon did decides the words: a window (ending) keeps Access open until it ends; anything else ended it now.
        const after = await callDaemon<PeopleList>(ctx.ctl, 'GET', '/v1/people').then(
          (l) => l.people.find((x) => x.id === p.id) ?? null,
          () => undefined,
        );
        if (after === undefined ? !flags.now && !flags.forget : after?.state === 'ending') {
          const until = after?.endingUntil?.slice(0, 10);
          io.out(`Sharing with ${p.name} ends ${until ? `on ${until}` : 'in 7 days'}; they can download their data until then.\n`);
          io.out(accessStepAfter(p.emailLabel, until));
          return EXIT.ok;
        }
        io.out(`${p.name} is removed${flags.forget ? ', and their space deleted' : ''}.\n`);
        io.out(accessStep(p.emailLabel, false));
        return EXIT.ok;
      }
      case 'todos': {
        const p = await find(ctx, need('a person'));
        const r = await callDaemon<{ todos: { title: string; due?: { day: string; time?: string }; by?: string }[] }>(ctx.ctl, 'GET', `/v1/people/${p.id}/todos`);
        for (const t of r.todos) io.out(`  ${t.due ? `${t.due.day}${t.due.time ? ` ${t.due.time}` : ''}  ` : ''}${clean(t.title)}${t.by === '' ? '  (from you)' : ''}\n`);
        if (r.todos.length === 0) io.out('Nothing open.\n');
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown action "${action}"`);
    }
  },
);
