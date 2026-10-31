/**
 * Synthetic v0.5 data for the README's Meetings pictures
 * (scripts/screenshots.mjs, `--fixture test/integration/web-fixture-v05.ts
 * --export webFixtureV05`): the v0.4 fixture (web-fixture-v04.ts) with
 * Meetings on, plus what every v0.5 phone route answers. Every name, line
 * and picture is made up; the screenshots are flat colour frames.
 *
 * The day is the v0.4 fixture's (Friday 30 October 2026, 13:25 in London):
 * a "Design review" running since 13:02, "Launch review" this morning with
 * its summary, decisions and action items (one added to the project's
 * todos), and older calls across the week, one with its summary still
 * failed and one with too little said.
 *
 * `v04.answer(method, url)` answers the v0.5 meetings routes first (a
 * screenshot as `{ bytes, type }`), then every v0.4 route as before.
 */
import {
  MeetingDetailSchema,
  MeetingsListSchema,
  MeetingsStatusSchema,
  ROUTES,
  type Meeting,
  type MeetingDetail,
  type MeetingLine,
  type MeetingShot,
  type MeetingsList,
  type RouteDef,
} from '@jantar/protocol';
import { makePng } from '../fixtures/runtime/images.mjs';
import { lid, webFixtureV04, type V04Reply, type WebFixtureV04, type WebFixtureV04Options } from './web-fixture-v04.js';

const MIN = 60_000;

/** A reply with bytes instead of JSON (a screenshot). */
export interface V05Reply extends V04Reply {
  bytes?: Buffer;
  type?: string;
}

export interface WebFixtureV05 extends WebFixtureV04 {
  v05: {
    list: MeetingsList;
    details: Record<string, MeetingDetail>;
    /** The meeting with every section, for the meeting page's picture. */
    featured: string;
  };
}

const V05_ROUTES = (Object.entries(ROUTES) as Array<[string, RouteDef]>)
  .filter(([, r]) => r.phase === 'v0.5' && !r.path.startsWith('/v1/ext/'))
  .map(([name, r]) => ({ name, method: r.method, re: new RegExp(`^${r.path.replace(/:([A-Za-z]+)/g, '(?<$1>[^/]+)')}$`) }));

function routeOf(method: string, path: string): { name: string; params: Record<string, string> } | null {
  for (const r of V05_ROUTES) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) return { name: r.name, params: Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])) };
  }
  return null;
}

export function webFixtureV05(opts: WebFixtureV04Options = {}): WebFixtureV05 {
  const base = webFixtureV04(opts);
  const now = base.now;
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const st = base.state.state as unknown as { daemon: { features: Record<string, unknown>; daemonVersion: string } };
  st.daemon.features = { ...st.daemon.features, meetings: true };
  st.daemon.daemonVersion = '0.5.1';
  const landing = base.v04.projects.find((p) => p.name === 'Landing page')!;
  const docs = base.v04.projects.find((p) => p.name === 'Jantar docs')!;

  const meeting = (n: number, over: Partial<Meeting> & Pick<Meeting, 'name' | 'startedAt' | 'endedAt'>): Meeting => ({
    id: lid(500 + n),
    site: 'meet',
    autoTodos: false,
    notes: true,
    lines: 0,
    shots: 0,
    summary: 'done',
    ...over,
  });

  // ----- Launch review: this morning, every section -----
  const launchStart = 205;
  const turns: Array<[string, string]> = [
    ['Priya', 'Morning all. The goal today is to agree the launch date for the new landing page.'],
    ['Sam', 'The pricing copy is final, and the hero screenshot still needs the new board.'],
    ['You', 'I can update the hero screenshot today, the board redesign is merged.'],
    ['Priya', 'Good. Then Friday the 6th works if the docs are ready by Wednesday.'],
    ['Sam', 'The docs need the security notes for 0.5 and the extension guide.'],
    ['You', 'I will write the extension guide; the security notes are half done.'],
    ['Priya', 'Let us keep the current hosting and revisit after launch.'],
    ['Sam', 'Agreed. I will send the revised quote to the hosting company today.'],
    ['Priya', 'And I will book the review room for Thursday afternoon.'],
    ['You', 'Thursday at three works for me.'],
    ['Sam', 'One more thing: the signup form needs a spam check before launch.'],
    ['Priya', 'Let us add that to next week. Thanks everyone.'],
  ];
  const lines: MeetingLine[] = turns.map(([speaker, text], i) => ({ id: `a1b2c3d4-${i + 1}`, at: iso(launchStart - 2 - i * 3), speaker, text }));
  const shots: MeetingShot[] = [
    { id: lid(601), at: iso(launchStart - 8), bytes: 412_000 },
    { id: lid(602), at: iso(launchStart - 26), bytes: 388_000 },
  ];
  const launch = meeting(1, {
    name: 'Launch review',
    people: 'Priya, Sam',
    projectId: landing.id,
    projectName: landing.name,
    autoTodos: true,
    startedAt: iso(launchStart),
    endedAt: iso(launchStart - 38),
    endReason: 'user',
    lines: lines.length,
    shots: shots.length,
    summary: 'done',
    gist: 'The team agreed to launch the landing page on Friday the 6th, once the docs are ready on Wednesday.',
  });
  const launchDetail: MeetingDetail = {
    meeting: launch,
    summary: {
      state: 'done',
      text: 'The team agreed to launch the landing page on Friday the 6th, once the docs are ready on Wednesday. The pricing copy is final; the hero screenshot and the extension guide are still to do. Hosting stays as it is until after launch.',
      decisions: ['Launch on Friday the 6th if the docs are ready by Wednesday.', 'Keep the current hosting until after launch.', 'The spam check on the signup form waits until next week.'],
      items: [
        { title: 'Update the hero screenshot with the new board', owner: 'You', todoId: lid(213) },
        { title: 'Write the extension guide', owner: 'You' },
        { title: 'Send the revised quote to the hosting company', owner: 'Sam' },
        { title: 'Book the review room for Thursday afternoon', owner: 'Priya' },
      ],
      at: iso(launchStart - 39),
    },
    lines,
    shots,
  };

  // ----- The rest of the week -----
  const running = meeting(2, { name: 'Design review', site: 'teams', people: 'Alex', projectId: docs.id, projectName: docs.name, startedAt: iso(23), endedAt: null, lines: 41, shots: 2, summary: 'none' });
  const list: Meeting[] = [
    running,
    launch,
    meeting(3, { name: 'Weekly sync', people: 'Priya, Sam, Alex', startedAt: iso(60 * 24 + 180), endedAt: iso(60 * 24 + 150), endReason: 'left', lines: 96, shots: 1, gist: 'Moving the flat on the 28th; the boxes arrive Monday and Alex takes the plants.' }),
    meeting(4, { name: 'Vendor call', site: 'teams', startedAt: iso(60 * 24 * 2 + 120), endedAt: iso(60 * 24 * 2 + 95), endReason: 'closed', lines: 58, summary: 'failed' }),
    meeting(5, { name: 'Docs pairing', projectId: docs.id, projectName: docs.name, startedAt: iso(60 * 24 * 3 + 300), endedAt: iso(60 * 24 * 3 + 250), endReason: 'user', lines: 133, shots: 4, gist: 'Agreed the order of the security notes and who writes the extension guide.' }),
    meeting(6, { name: 'Quick check-in', startedAt: iso(60 * 24 * 4 + 60), endedAt: iso(60 * 24 * 4 + 57), endReason: 'user', lines: 3, summary: 'none' }),
  ];
  const meetingsList = MeetingsListSchema.parse({ meetings: list, next: null, running });
  const details: Record<string, MeetingDetail> = { [launch.id]: MeetingDetailSchema.parse(launchDetail) };
  const status = MeetingsStatusSchema.parse({
    on: true,
    open: true,
    meetings: list.length,
    running: 1,
    shotsBytes: 52_000_000,
    summary: { available: true },
    extensions: [{ id: lid(701), pairedAt: iso(60 * 24 * 9), lastSeenAt: iso(1) }],
  });
  const picture = makePng(1280, 800, { rgb: [0x2f, 0x6f, 0x4f] });

  const ok = (body: unknown): V05Reply => ({ status: 200, body });
  const answer = (method: string, url: URL): V05Reply | null => {
    const r = routeOf(method, url.pathname);
    if (!r) return base.v04.answer(method, url);
    switch (r.name) {
      case 'meetingsStatus':
        return ok(status);
      case 'meetingsList': {
        const project = url.searchParams.get('project');
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const meetings = meetingsList.meetings.filter((m) => (!project || (project === 'none' ? !m.projectId : m.projectId === project)) && (!q || m.name.toLowerCase().includes(q)));
        return ok({ ...meetingsList, meetings });
      }
      case 'meetingGet': {
        const d = details[r.params.id ?? ''];
        if (d) return ok(d);
        const m = list.find((x) => x.id === r.params.id);
        return m ? ok({ meeting: m, summary: { state: m.summary, decisions: [], items: [] }, lines: [], shots: [] }) : { status: 404, body: { error: { code: 'not_found', message: 'No such meeting.' } } };
      }
      case 'meetingShot':
        return { status: 200, body: null, bytes: picture, type: 'image/png' };
      default:
        // A write: an id for an item's todo, else ok. Nothing changes.
        return ok(r.name === 'meetingItemTodo' ? { id: lid(799) } : { ok: true });
    }
  };

  return { ...base, v04: { ...base.v04, answer }, v05: { list: meetingsList, details, featured: launch.id } };
}
