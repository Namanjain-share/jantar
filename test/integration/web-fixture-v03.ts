/**
 * Synthetic v0.3 data for the browser checks of the built web app
 * (web-v03.integration.test.ts): the board fixture with every v0.3 switch
 * on, plus what the Files, New session, Rewrite and Controls routes answer.
 * Every name, folder, file and address is made up.
 *
 * The files are the ones spec 6 W2 opens under the strict CSP: a .ts, a .md
 * with a <script>, an <img onerror> and a javascript: link, an .html, an
 * .svg with a <script> and an onload, a PDF that names two base-14 fonts
 * without embedding them (so pdf.js fetches its standard font files), and an
 * .ipynb with HTML, JavaScript and PNG outputs. Anything that ran would set
 * `window.__pwned`.
 */
import {
  V03_LAUNCH_FLAGS,
  FileChangeSchema,
  FileRootSchema,
  FileStatSchema,
  FileTextSchema,
  FoldersListResponseSchema,
  LaunchJobSchema,
  LaunchPreviewSchema,
  RewriteDetailSchema,
  launchFlagArgs,
  launchFlagsDangerous,
  type FileChange,
  type FileEntry,
  type FileKind,
  type FileListing,
  type FileRoot,
  type FileStat,
  type FileText,
  type FolderEntry,
  type FoldersListResponse,
  type LaunchAccount,
  type LaunchFlags,
  type LaunchJob,
  type LaunchPreview,
  type RewriteDetail,
  type RewriteJob,
  type Session,
} from '@jantar/protocol';
import { sidOf, webFixture, type WebFixture } from './web-fixture.js';

const MIN = 60_000;

/** The folder every v0.3 screen works in (session 4's, "jantar · board redesign"). */
export const WORK_DISPLAY = '~/Desktop/work';
/** Where WORK_DISPLAY really is: the home in it is the placeholder the docs use, so the folder row and the command agree. */
const WORK_REAL = '/Users/you/Desktop/work';

export const PATHS = {
  ts: 'jantar/src/cookies.ts',
  md: 'jantar/docs/notes.md',
  html: 'jantar/docs/page.html',
  svg: 'jantar/assets/logo.svg',
  png: 'jantar/assets/shot.png',
  pdf: 'jantar/docs/spec.pdf',
  ipynb: 'jantar/notebooks/weekly.ipynb',
} as const;

const TS = `/** Synthetic: the session cookie's options. */
export interface CookieOptions {
  name: string;
  maxAgeS: number;
  secure: boolean;
}

export function cookieHeader(value: string, o: CookieOptions): string {
  const parts = [\`\${o.name}=\${encodeURIComponent(value)}\`, \`Max-Age=\${o.maxAgeS}\`, 'Path=/', 'HttpOnly'];
  if (o.secure) parts.push('Secure');
  return parts.join('; ');
}
`;

const MD = `# Release notes (synthetic)

Some **bold** text, \`inline code\` and a [relative link](../src/cookies.ts).

<script>window.__pwned = 'md-script'</script>

<img src="x" onerror="window.__pwned = 'md-img'">

[A javascript: link](javascript:window.__pwned='md-link')

![The screen](../assets/shot.png)

\`\`\`ts
const maxAgeS: number = 3600;
\`\`\`
`;

const HTML = `<!doctype html>
<title>Synthetic page</title>
<script>window.__pwned = 'html-script'</script>
<p onclick="window.__pwned = 'html-click'">Hello</p>
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120" onload="window.__pwned = 'svg-onload'">
  <script>window.__pwned = 'svg-script'</script>
  <rect x="8" y="8" width="224" height="104" rx="6" fill="#d9d4c7"/>
  <text x="24" y="70" font-family="sans-serif" font-size="22" fill="#1e1e2e">synthetic</text>
</svg>
`;

/**
 * A one-page PDF whose text uses Helvetica and Times-Roman, neither
 * embedded: pdf.js draws them from its standard font files
 * (LiberationSans-Regular.ttf and FoxitSerif.pfb).
 */
export function syntheticPdf(): Buffer {
  const content = 'BT /F1 26 Tf 24 128 Td (Synthetic PDF) Tj ET\nBT /F2 18 Tf 24 72 Td (Times, not embedded) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function notebook(png: Buffer): string {
  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Weekly numbers\n', 'Synthetic data. <script>window.__pwned = "nb-markdown"</script>'] },
      {
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        source: ['import json\n', 'rows = [1, 2, 3]\n', 'print(sum(rows))'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['6\n'] },
          {
            output_type: 'display_data',
            metadata: {},
            data: { 'text/html': ['<b>bold</b><script>window.__pwned = "nb-html"</script>'], 'text/plain': ['<IPython.core.display.HTML object>'] },
          },
          { output_type: 'display_data', metadata: {}, data: { 'image/png': png.toString('base64'), 'text/plain': ['<Figure size 640x480>'] } },
          { output_type: 'execute_result', execution_count: 1, metadata: {}, data: { 'application/javascript': ['window.__pwned = "nb-js"'] } },
        ],
      },
    ],
  };
  return `${JSON.stringify(nb, null, 1)}\n`;
}

export interface FixtureFile {
  stat: FileStat;
  /** Text kinds: what GET /v1/files/text answers (one window, the whole file). */
  text?: FileText;
  /** Raw kinds (images, PDF): the bytes GET /v1/files/raw serves, and their type. */
  raw?: { type: string; body: Buffer };
}

export interface V03Fixture {
  roots: FileRoot[];
  /** By path relative to the root (every root id serves the same tree). */
  files: Map<string, FixtureFile>;
  /** Directory listings, by path ('' is the root). */
  dirs: Map<string, FileListing>;
  changes: FileChange[];
  /** The new-session browser: folder listings by path. */
  folders: Map<string, FoldersListResponse>;
  accounts: LaunchAccount[];
  preview(q: URLSearchParams): LaunchPreview;
  /** Launches by id, with the masked screen tail GET /v1/launches/:id carries. */
  launches: Map<string, { job: LaunchJob; screenTail?: string }>;
  /** A launch the start sheet's hold creates. */
  started(flags: LaunchFlags, account: number): LaunchJob;
  rewrite: { job(sid: string, text: string): RewriteJob; detail(job: RewriteJob, input: string): RewriteDetail; prompt: string };
  /** The terminal screenshot's bytes (a PNG). */
  screenshot: Buffer;
}

export interface WebFixtureV03 extends WebFixture {
  v03: V03Fixture;
  /** The your-turn session the v0.3 screens open (account 1, mode Accept edits, 4 files changed). */
  workSid: string;
  /** Launches on the board: one at Claude's trust dialog, one still opening. */
  dialogLaunch: string;
  openingLaunch: string;
}

const EXT_KIND: Record<string, { kind: FileKind; language?: string }> = {
  ts: { kind: 'text', language: 'typescript' },
  md: { kind: 'markdown', language: 'markdown' },
  html: { kind: 'text', language: 'html' },
  svg: { kind: 'svg' },
  png: { kind: 'image' },
  pdf: { kind: 'pdf' },
  ipynb: { kind: 'notebook', language: 'json' },
};

/** The board fixture with v0.3 on. `png` is a real PNG (the test takes it with Chromium). */
export function webFixtureV03(png: Buffer, now: number = Date.now()): WebFixtureV03 {
  const base = webFixture(now);
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * MIN).toISOString();
  const workSid = sidOf(4);
  const st = base.state.state as unknown as {
    sessions: Record<string, Session>;
    launches: Record<string, LaunchJob>;
    daemon: Record<string, unknown>;
  };

  st.daemon = {
    ...st.daemon,
    features: { files: true, launch: true, rewrite: true, controls: true, screenshots: true, screenshotSelect: false, escape: false, clearDraft: false },
  };
  // Modes and changed-file counts the control bar and the board's "4 files" read.
  const patch = (n: number, p: Partial<Session>) => {
    const s = st.sessions[sidOf(n)];
    if (s) Object.assign(s, p);
  };
  patch(4, { mode: 'acceptEdits', filesChanged: 4 } as Partial<Session>);
  patch(5, { mode: 'default', filesChanged: 1 } as Partial<Session>);
  patch(6, { mode: 'plan' } as Partial<Session>);

  // ----- Files -----
  const sessionRoot: FileRoot = { id: `s.${workSid}`, kind: 'session', label: 'jantar', sid: workSid, display: `${WORK_DISPLAY}/jantar`, home: false };
  const roots: FileRoot[] = [{ id: 'r.work', kind: 'configured', label: 'work', display: WORK_DISPLAY, home: false }, sessionRoot].map((r) =>
    FileRootSchema.parse(r),
  );
  const pdf = syntheticPdf();
  const texts: Record<string, string> = { [PATHS.ts]: TS, [PATHS.md]: MD, [PATHS.html]: HTML, [PATHS.svg]: SVG, [PATHS.ipynb]: notebook(png) };
  const files = new Map<string, FixtureFile>();
  const add = (path: string, body: string | Buffer, minutes: number, raw?: string) => {
    const ext = path.slice(path.lastIndexOf('.') + 1);
    const k = EXT_KIND[ext] ?? { kind: 'binary' as FileKind };
    const size = typeof body === 'string' ? Buffer.byteLength(body) : body.length;
    const stat = FileStatSchema.parse({ type: 'file', size, mtime: iso(minutes), kind: k.kind, ...(k.language ? { language: k.language } : {}) });
    const f: FixtureFile = { stat };
    if (typeof body === 'string') {
      f.text = FileTextSchema.parse({ text: body, offset: 0, next: null, size, bom: false, eol: 'lf', ...(k.language ? { language: k.language } : {}), mtime: iso(minutes), warnings: [] });
    } else if (raw) {
      f.raw = { type: raw, body };
    }
    files.set(path, f);
  };
  add(PATHS.ts, texts[PATHS.ts]!, 3);
  add(PATHS.md, texts[PATHS.md]!, 5);
  add(PATHS.html, texts[PATHS.html]!, 40);
  add(PATHS.svg, texts[PATHS.svg]!, 7);
  add(PATHS.png, png, 9, 'image/png');
  add(PATHS.pdf, pdf, 60, 'application/pdf');
  add(PATHS.ipynb, texts[PATHS.ipynb]!, 11);

  // Listings: every folder on the way to each file.
  const dirs = new Map<string, FileListing>();
  const children = new Map<string, Map<string, FileEntry>>();
  for (const [path, f] of files) {
    const segs = path.split('/');
    for (let i = 0; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      const name = segs[i]!;
      const kids = children.get(dir) ?? new Map<string, FileEntry>();
      children.set(dir, kids);
      kids.set(name, i === segs.length - 1 ? { name, type: 'file', size: f.stat.size, mtime: f.stat.mtime } : { name, type: 'dir' });
    }
  }
  for (const [dir, kids] of children) {
    const entries = [...kids.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    dirs.set(dir, { root: 'r.work', path: dir, entries, next: null, hiddenProtected: dir === 'jantar' ? 1 : 0, truncated: false });
  }

  const change = (n: number, path: string, tool: FileChange['last']['tool'], minutes: number, over: Partial<FileChange> = {}): FileChange =>
    FileChangeSchema.parse({
      changeId: `chg-${n}`,
      sid: workSid,
      path: `${WORK_REAL}/${path}`,
      rootId: 'r.work',
      rel: path,
      viewable: 'yes',
      firstAt: iso(minutes + 20),
      lastAt: iso(minutes),
      ops: 2,
      tools: [tool],
      created: false,
      added: 12,
      removed: 3,
      last: { status: 'ok', tool, at: iso(minutes) },
      ...over,
    });
  const changes = [
    change(1, PATHS.ts, 'Edit', 3),
    change(2, PATHS.md, 'Write', 5, { created: true, ops: 1, removed: 0 }),
    change(3, PATHS.svg, 'Write', 7, { ops: 1 }),
    change(4, PATHS.ipynb, 'NotebookEdit', 11, { added: 0, removed: 0, ops: 1 }),
  ];

  // ----- New session -----
  const folderEntry = (name: string, over: Partial<FolderEntry> = {}): FolderEntry => ({ name, link: false, git: true, claudeMd: false, live: 0, pinned: false, ...over });
  const folderList = (path: string, entries: FolderEntry[]): FoldersListResponse =>
    FoldersListResponseSchema.parse({
      root: 'r.work',
      path,
      display: path ? `${WORK_DISPLAY}/${path}` : WORK_DISPLAY,
      entries,
      next: null,
      hiddenProtected: 0,
      truncated: false,
      total: entries.length,
    });
  const folders = new Map<string, FoldersListResponse>([
    [
      '',
      folderList('', [
        folderEntry('jantar', { live: 1, pinned: true, claudeMd: true, lastAccount: 1, lastUsed: iso(2) }),
        folderEntry('api-server', { live: 2, lastAccount: 5, lastUsed: iso(1) }),
        folderEntry('marketing-site-redesign-with-new-components', { git: false }),
        folderEntry('docs-site', { lastAccount: 7, lastUsed: iso(9) }),
        folderEntry('scratch', { git: false }),
      ]),
    ],
    ['api-server', folderList('api-server', [folderEntry('migrations', { git: false })])],
  ]);
  const accounts: LaunchAccount[] = [
    { id: 1, label: 'vega', fiveHourPct: 22, sevenDayPct: 31, resetsAt: iso(-142), live: 2, selectable: true, held: false },
    { id: 4, label: 'deneb', fiveHourPct: 92, sevenDayPct: 70, resetsAt: iso(-122), live: 1, selectable: false, why: 'past the ceiling', held: false },
    { id: 5, label: 'altair', fiveHourPct: 34, sevenDayPct: 40, resetsAt: iso(-192), live: 2, selectable: true, held: true },
    { id: 7, label: 'castor', fiveHourPct: 12, sevenDayPct: 36, resetsAt: iso(-182), live: 1, selectable: true, held: false },
    { id: 8, label: 'pollux', fiveHourPct: 0, sevenDayPct: 8, live: 0, selectable: true, held: false },
    { id: 10, label: 'mira', fiveHourPct: 58, sevenDayPct: 44, resetsAt: iso(-352), live: 2, selectable: true, held: true },
    { id: 11, label: 'antares', sevenDayPct: 21, live: 0, selectable: false, why: 'token expired', held: false },
  ];
  const preview = (q: URLSearchParams): LaunchPreview => {
    const flags: LaunchFlags = { ...V03_LAUNCH_FLAGS };
    const permission = q.get('permission');
    if (permission) flags.permission = permission as LaunchFlags['permission'];
    const chrome = q.get('chrome');
    if (chrome !== null) flags.chrome = chrome === '1';
    const effort = q.get('effort');
    if (effort) flags.effort = effort as LaunchFlags['effort'];
    const model = q.get('model');
    if (model) flags.model = model as LaunchFlags['model'];
    const account = q.get('account');
    const manual = account !== null && account !== 'auto';
    const pick = manual ? Number(account) : 7;
    const path = q.get('path') ?? '';
    const name = path.split('/').pop() || 'work';
    const folder = path ? `${WORK_REAL}/${path}` : WORK_REAL;
    return LaunchPreviewSchema.parse({
      root: q.get('root') ?? 'r.work',
      path,
      display: path ? `${WORK_DISPLAY}/${path}` : WORK_DISPLAY,
      account: { pick, source: manual ? 'manual' : 'auto', reason: manual ? `${String(pick).padStart(2, '0')} · resets in 2h10` : 'most room · 5h 12% · resets in 3h02 · 14:20' },
      accounts,
      flags,
      defaults: V03_LAUNCH_FLAGS,
      args: launchFlagArgs(flags),
      command: `cd -- '${folder}' && cs ${pick} -- ${[...launchFlagArgs(flags), '--session-id', '<session id>', '--name', name].join(' ')}`,
      name,
      warnings: flags.effort === 'ultracode' ? [] : [{ kind: 'effort', text: 'An account move restarts it with ultracode effort' }],
    });
  };

  const launchJob = (id: string, over: Partial<LaunchJob>): LaunchJob =>
    LaunchJobSchema.parse({
      id,
      createdAt: iso(1),
      updatedAt: iso(0.2),
      actor: 'device:dev2',
      rootId: 'r.work',
      folder: `${WORK_REAL}/api-server`,
      display: `${WORK_DISPLAY}/api-server`,
      account: 7,
      accountSource: 'auto',
      requested: 'auto',
      flags: V03_LAUNCH_FLAGS,
      dangerous: launchFlagsDangerous(V03_LAUNCH_FLAGS),
      name: 'api-server',
      sid: `b0b0b0b0-0000-4000-8000-${id.padStart(12, '0').slice(-12)}`,
      stage: 'queued',
      steps: [{ at: iso(1), stage: 'queued', detail: '' }],
      ...over,
    });
  const dialogLaunch = 'L0000000000000000000000001';
  const openingLaunch = 'L0000000000000000000000002';
  const trust = launchJob(dialogLaunch, {
    tty: '/dev/ttys014',
    windowId: '4242',
    stage: 'dialog',
    dialog: { title: 'Do you trust the files in this folder?', options: ['Yes, proceed', 'No, exit'], current: 0, since: iso(0.3) },
    steps: [
      { at: iso(1), stage: 'queued', detail: '' },
      { at: iso(0.9), stage: 'opening', detail: 'ttys014' },
      { at: iso(0.8), stage: 'starting', detail: 'cs 7' },
      { at: iso(0.3), stage: 'dialog', detail: 'Do you trust the files in this folder?' },
    ],
  });
  const opening = launchJob(openingLaunch, {
    folder: `${WORK_REAL}/docs-site`,
    display: `${WORK_DISPLAY}/docs-site`,
    name: 'docs-site',
    account: 8,
    stage: 'opening',
    steps: [
      { at: iso(0.2), stage: 'queued', detail: '' },
      { at: iso(0.1), stage: 'opening', detail: '' },
    ],
  });
  const launches = new Map<string, { job: LaunchJob; screenTail?: string }>([
    [
      dialogLaunch,
      {
        job: trust,
        screenTail:
          ' Do you trust the files in this folder?\n\n /Users/you/Desktop/work/api-server\n\n Claude Code may read files in this folder.\n\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to exit',
      },
    ],
    [openingLaunch, { job: opening }],
  ]);
  st.launches = { [dialogLaunch]: trust, [openingLaunch]: opening };
  const started = (flags: LaunchFlags, account: number) =>
    launchJob('L0000000000000000000000003', {
      createdAt: iso(0),
      updatedAt: iso(0),
      account,
      flags,
      dangerous: launchFlagsDangerous(flags),
      stage: 'opening',
      steps: [
        { at: iso(0), stage: 'queued', detail: '' },
        { at: iso(0), stage: 'opening', detail: '' },
      ],
    });

  // ----- Rewrite -----
  const prompt =
    'Fix the login redirect loop: after sign-in the app sends the user back to /login. Check where the session cookie is set (auth/session.ts and middleware/cookies.ts), keep one owner for it, and add a test for the redirect.';
  const rewriteJob = (sid: string, text: string): RewriteJob => ({
    id: 'rw-e2e-0001',
    sid,
    deviceId: 'dev2',
    state: 'ready',
    model: 'opus',
    account: 7,
    input: { hash: 'sha256:synthetic-input', length: text.length },
    prompt: { hash: 'sha256:synthetic-prompt', length: prompt.length, flags: { expanded: false, newTokens: 1, leading: null, preface: false } },
    ms: 4200,
    promptVersion: 'v1',
    createdAt: iso(0.1),
    updatedAt: iso(0),
  });
  const detail = (job: RewriteJob, input: string): RewriteDetail =>
    RewriteDetailSchema.parse({ state: job.state, prompt, job, input, newTokens: ['middleware/cookies.ts'] });

  return {
    ...base,
    workSid,
    dialogLaunch,
    openingLaunch,
    v03: { roots, files, dirs, changes, folders, accounts, preview, launches, started, rewrite: { job: rewriteJob, detail, prompt }, screenshot: png },
  };
}
