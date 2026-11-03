/**
 * jantar people (v0.12 People, spec 9.5): the people on this Mac, at the Mac
 * (ctl.sock). Every command that lets a person in, shapes what they are
 * offered or ends their space runs here only (`localOnly` routes):
 *
 *   people on [--name <your name>] | off
 *   people doctor
 *   people add <name> [--email <addr>] [--color <c>] [--no-food]
 *   people offer <name|id> [--preset light|standard|everything]
 *                [--see todos,meds=full|adherence|off,weight,food,...]
 *                [--assign todos,meds] [--edit-hers todos,meds,weight]
 *   people modules <name|id> --food on|off
 *   people invite <name|id> [--json]
 *   people list
 *   people devices <name|id>
 *   people revoke <device-id>
 *   people revoke-invite <name|id>
 *   people remove <name|id> [--now] [--forget]
 *   people todos <name|id>
 *
 * Nothing here prints a last-seen, an address or a user agent of theirs
 * (C20), nor any text of their journal, comments, chat or sleep (O15).
 * Adding or removing an email prints the Cloudflare Access step: Jantar
 * holds no Cloudflare token and can't make that change.
 */
import type { PeopleDoctor, PeopleList, PersonInviteReply, PersonView } from '@jantar/protocol/people';
import { UsageError, parseArgs } from '../args.js';
import { EXIT, defineCommand, type CliContext } from '../command.js';
import { callDaemon } from '../ctl.js';

const USAGE = 'jantar people <on|off|doctor|add|offer|modules|invite|list|devices|revoke|revoke-invite|remove|todos> ...';

const FIELD_GROUPS = ['see', 'assign', 'editHers'] as const;

/** `todos,meds=adherence,weight=off` into a patch of one group (a bare name is on; `x=off` turns it off). */
export function fieldList(group: (typeof FIELD_GROUPS)[number], value: string | undefined): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {};
  if (!value) return out;
  for (const part of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, level] = part.split('=') as [string, string | undefined];
    if (!/^[a-z]+$/i.test(name)) throw new UsageError(`"${part}" is not a field`);
    if (group === 'see' && (name === 'meds' || name === 'review')) out[name] = level ?? 'full';
    else out[name] = level === undefined ? true : level !== 'off' && level !== 'false';
  }
  return out;
}

async function find(ctx: CliContext, who: string): Promise<PersonView> {
  const list = await callDaemon<PeopleList>(ctx.ctl, 'GET', '/v1/people');
  const hit = list.people.find((p) => p.id === who) ?? list.people.filter((p) => p.name.toLowerCase() === who.toLowerCase())[0];
  if (!hit) throw new UsageError(`no person "${who}" (see: jantar people list)`);
  return hit;
}

function accessStep(email: string | undefined, add: boolean): string {
  const who = email ?? 'their email';
  return add
    ? `In Zero Trust > Access > Applications > Jantar people > Policies > People > Include > Emails, add ${who}, then Save. Jantar holds no Cloudflare token and can't do this for you.\n`
    : `In Zero Trust > Access > Applications > Jantar people > Policies > People, remove ${who}. Optionally, My Team > Users > them > Revoke session.\n`;
}

const ON_WORDS: Record<string, string> = {
  'see.todos': 'sees their to-dos and reminders',
  'see.meds': 'sees their medicines',
  'see.weight': 'sees their weight',
  'see.food': 'sees their food log',
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
    summary: 'Share a space on this Mac with one other person (People): invite, the offer, devices, remove.',
    usage: USAGE,
    owner: 'WP-PEOPLE',
    help:
      '  people on [--name <your name>] | off      turn People on (their exits always work) or off\n' +
      '  people add <name> [--email <addr>] [--no-food]\n' +
      '  people offer <name> [--preset light|standard|everything] [--see ...] [--assign ...] [--edit-hers ...]\n' +
      '  people invite <name> [--json]             a 24-hour, single-use join link\n' +
      '  people list | devices <name> | todos <name>\n' +
      '  people revoke <device-id> | revoke-invite <name> | remove <name> [--now] [--forget]\n' +
      '  people modules <name> --food on|off | doctor',
  },
  async (argv, ctx) => {
    const { flags, positionals } = parseArgs(
      argv,
      {
        name: { type: 'string', help: 'your name, as they read it' },
        email: { type: 'string', help: 'their email (a reminder for the Access step)' },
        color: { type: 'string', help: 'teal, violet, amber, rose, sky or lime' },
        food: { type: 'string', help: 'on or off (modules); --no-food on add' },
        preset: { type: 'string', help: 'light, standard (default) or everything' },
        see: { type: 'string', help: 'todos,meds=full|adherence|off,weight,food' },
        assign: { type: 'string', help: 'todos,meds' },
        'edit-hers': { type: 'string', help: 'todos,meds,weight' },
        json: { type: 'boolean', help: 'print JSON' },
        now: { type: 'boolean', help: 'end sharing at once (no 7-day window)' },
        forget: { type: 'boolean', help: 'delete their space at once' },
        'no-food': { type: 'boolean', help: 'add them without a food log' },
        qr: { type: 'boolean', help: 'accepted for compatibility (the link is printed)' },
      },
      { min: 1, max: 2 },
    );
    const [action, who] = positionals;
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
        io.out('People is on.\n');
        return EXIT.ok;
      }
      case 'off':
        await callDaemon(ctx.ctl, 'POST', '/v1/people/switch', { on: false });
        io.out('People is off. Partners can still download their data or leave.\n');
        return EXIT.ok;
      case 'doctor': {
        const d = await callDaemon<PeopleDoctor>(ctx.ctl, 'GET', '/v1/people/doctor');
        for (const c of d.checks) io.out(`${c.ok ? 'ok  ' : 'FIX '} ${c.name}: ${c.detail}\n`);
        return d.checks.every((c) => c.ok) ? EXIT.ok : EXIT.failed;
      }
      case 'add': {
        const name = need('a name');
        const body = {
          name,
          ...(flags.email ? { email: flags.email } : {}),
          ...(flags.color ? { color: flags.color } : {}),
          modules: { food: !flags['no-food'] && flags.food !== 'off' },
        };
        const r = await callDaemon<{ id: string }>(ctx.ctl, 'POST', '/v1/people', body);
        io.out(`Added ${name} (${r.id}). No invite yet.\n`);
        io.out(accessStep(flags.email, true));
        io.out(`Next: jantar people offer ${name} (optional), then jantar people invite ${name}\n`);
        return EXIT.ok;
      }
      case 'offer': {
        const p = await find(ctx, need('a person'));
        const body: Record<string, unknown> = {};
        if (flags.preset) body.preset = flags.preset;
        const see = fieldList('see', flags.see);
        const assign = fieldList('assign', flags.assign);
        const editHers = fieldList('editHers', flags['edit-hers']);
        if (Object.keys(see).length) body.see = see;
        if (Object.keys(assign).length) body.assign = assign;
        if (Object.keys(editHers).length) body.editHers = editHers;
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
        // Her food log is a later phase (AREAS.food): say so, rather than promise a screen this release lacks.
        io.out(flags.food === 'on' ? `${p.name}'s food module is on. People has no food log in this release, so nothing changes for them yet.\n` : `${p.name}'s food log is off.\n`);
        return EXIT.ok;
      }
      case 'invite': {
        const p = await find(ctx, need('a person'));
        const r = await callDaemon<PersonInviteReply>(ctx.ctl, 'POST', `/v1/people/${p.id}/invite`);
        if (flags.json) {
          io.out(`${JSON.stringify(r)}\n`);
          return EXIT.ok;
        }
        io.out(`Send ${p.name} this link (it works once, until ${r.expiresAt}):\n\n  ${r.url}\n\n`);
        io.out('The link alone gets nobody in without the Access policy letting their email through.\n');
        return EXIT.ok;
      }
      case 'list': {
        const r = await callDaemon<PeopleList>(ctx.ctl, 'GET', '/v1/people');
        if (flags.json) {
          io.out(`${JSON.stringify(r)}\n`);
          return EXIT.ok;
        }
        io.out(`People is ${r.enabled ? 'on' : 'off'}.\n`);
        if (r.people.length === 0) io.out('Nobody yet. Add someone: jantar people add <name> --email <address>\n');
        for (const p of r.people) {
          const extra = p.state === 'invited' && p.invite ? ` (link until ${p.invite.expiresAt})` : p.state === 'ending' && p.endingUntil ? ` (until ${p.endingUntil})` : '';
          io.out(`  ${p.name}  ${p.state}${extra}  ${p.id}\n`);
        }
        return EXIT.ok;
      }
      case 'devices': {
        const p = await find(ctx, need('a person'));
        const r = await callDaemon<{ devices: { id: string; name: string; createdAt: string; accessEmail?: string; revokedAt?: string }[] }>(ctx.ctl, 'GET', `/v1/people/${p.id}/devices`);
        for (const d of r.devices) io.out(`  ${d.id}  ${d.name}  added ${d.createdAt.slice(0, 10)}${d.accessEmail ? `  ${d.accessEmail}` : ''}${d.revokedAt ? '  (revoked)' : ''}\n`);
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
            io.out(`Revoked ${did}. ${p.name}'s other devices were told.\n`);
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
        const p = await find(ctx, need('a person'));
        await callDaemon(ctx.ctl, 'POST', `/v1/people/${p.id}/remove`, { mode: flags.now ? 'now' : 'window', forget: Boolean(flags.forget) });
        io.out(flags.now || flags.forget ? `${p.name} is removed${flags.forget ? ', and their space deleted' : ''}.\n` : `Sharing with ${p.name} ends in 7 days; they can download their data until then.\n`);
        io.out(accessStep(p.emailLabel, false));
        return EXIT.ok;
      }
      case 'todos': {
        const p = await find(ctx, need('a person'));
        const r = await callDaemon<{ todos: { title: string; due?: { day: string; time?: string }; by?: string }[] }>(ctx.ctl, 'GET', `/v1/people/${p.id}/todos`);
        for (const t of r.todos) io.out(`  ${t.due ? `${t.due.day}${t.due.time ? ` ${t.due.time}` : ''}  ` : ''}${t.title}${t.by === '' ? '  (from you)' : ''}\n`);
        if (r.todos.length === 0) io.out('Nothing open.\n');
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown action "${action}"`);
    }
  },
);
