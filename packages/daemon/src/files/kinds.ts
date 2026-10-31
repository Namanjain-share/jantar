/**
 * What a file is, from its name: the viewer kind and the highlighting
 * language (Prism ids). Lookups go through `Map`s, never object keys, so a
 * file named `constructor` or `__proto__.md` resolves to nothing special.
 *
 * The name only suggests: text kinds are still sniffed (a `.ts` full of NULs
 * is binary), and raw bytes are served only when the magic bytes agree
 * (raw.ts).
 */
import type { FileKind } from '@jantar/protocol';

export interface KindInfo {
  kind: FileKind;
  language?: string;
}

const text = (language?: string): KindInfo => (language ? { kind: 'text', language } : { kind: 'text' });

/** By lower-cased extension (without the dot). */
const BY_EXT: ReadonlyMap<string, KindInfo> = new Map<string, KindInfo>([
  // Code
  ['ts', text('typescript')],
  ['mts', text('typescript')],
  ['cts', text('typescript')],
  ['tsx', text('tsx')],
  ['js', text('javascript')],
  ['mjs', text('javascript')],
  ['cjs', text('javascript')],
  ['jsx', text('jsx')],
  ['json', text('json')],
  ['jsonc', text('json')],
  ['json5', text('json')],
  ['jsonl', text('json')],
  ['py', text('python')],
  ['pyi', text('python')],
  ['rb', text('ruby')],
  ['go', text('go')],
  ['rs', text('rust')],
  ['java', text('java')],
  ['kt', text('kotlin')],
  ['kts', text('kotlin')],
  ['swift', text('swift')],
  ['c', text('c')],
  ['h', text('c')],
  ['cc', text('cpp')],
  ['cpp', text('cpp')],
  ['cxx', text('cpp')],
  ['hpp', text('cpp')],
  ['hh', text('cpp')],
  ['m', text('objectivec')],
  ['mm', text('objectivec')],
  ['cs', text('csharp')],
  ['php', text('php')],
  ['sh', text('bash')],
  ['bash', text('bash')],
  ['zsh', text('bash')],
  ['fish', text('bash')],
  ['ps1', text('powershell')],
  ['sql', text('sql')],
  ['graphql', text('graphql')],
  ['gql', text('graphql')],
  ['proto', text('protobuf')],
  ['lua', text('lua')],
  ['pl', text('perl')],
  ['r', text('r')],
  ['dart', text('dart')],
  ['scala', text('scala')],
  ['clj', text('clojure')],
  ['ex', text('elixir')],
  ['exs', text('elixir')],
  ['erl', text('erlang')],
  ['hs', text('haskell')],
  ['ml', text('ocaml')],
  ['vue', text('markup')],
  ['svelte', text('markup')],
  ['astro', text('markup')],
  ['html', text('markup')],
  ['htm', text('markup')],
  ['xml', text('markup')],
  ['plist', text('markup')],
  ['css', text('css')],
  ['scss', text('scss')],
  ['sass', text('sass')],
  ['less', text('less')],
  ['yaml', text('yaml')],
  ['yml', text('yaml')],
  ['toml', text('toml')],
  ['ini', text('ini')],
  ['cfg', text('ini')],
  ['conf', text('ini')],
  ['properties', text('properties')],
  ['tf', text('hcl')],
  ['hcl', text('hcl')],
  ['gradle', text('groovy')],
  ['groovy', text('groovy')],
  ['diff', text('diff')],
  ['patch', text('diff')],
  ['tex', text('latex')],
  ['dockerfile', text('docker')],
  ['mk', text('makefile')],
  // Plain text
  ['txt', text()],
  ['text', text()],
  ['log', text()],
  ['csv', text()],
  ['tsv', text()],
  ['rst', text()],
  ['adoc', text()],
  ['lock', text()],
  // Viewer kinds
  ['md', { kind: 'markdown', language: 'markdown' }],
  ['markdown', { kind: 'markdown', language: 'markdown' }],
  ['mdx', { kind: 'markdown', language: 'markdown' }],
  ['svg', { kind: 'svg', language: 'markup' }],
  ['ipynb', { kind: 'notebook', language: 'json' }],
  ['png', { kind: 'image' }],
  ['jpg', { kind: 'image' }],
  ['jpeg', { kind: 'image' }],
  ['gif', { kind: 'image' }],
  ['webp', { kind: 'image' }],
  ['avif', { kind: 'image' }],
  ['heic', { kind: 'image' }],
  ['pdf', { kind: 'pdf' }],
  // Known binaries: no sniffing needed
  ...[
    'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war', 'dmg', 'pkg', 'iso',
    'exe', 'dll', 'so', 'dylib', 'a', 'o', 'class', 'wasm', 'bin', 'dat', 'pyc', 'node',
    'db', 'sqlite', 'sqlite3', 'woff', 'woff2', 'ttf', 'otf', 'eot',
    'mp3', 'mp4', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'mov', 'avi', 'mkv', 'webm',
    'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'ai', 'sketch', 'fig',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'numbers', 'pages',
  ].map((ext): [string, KindInfo] => [ext, { kind: 'binary' }]),
]);

/** By lower-cased whole name, for files without a telling extension. */
const BY_NAME: ReadonlyMap<string, KindInfo> = new Map<string, KindInfo>([
  ['makefile', text('makefile')],
  ['gnumakefile', text('makefile')],
  ['dockerfile', text('docker')],
  ['containerfile', text('docker')],
  ['gemfile', text('ruby')],
  ['rakefile', text('ruby')],
  ['podfile', text('ruby')],
  ['brewfile', text('ruby')],
  ['justfile', text('makefile')],
  ['license', text()],
  ['licence', text()],
  ['readme', text()],
  ['changelog', text()],
  ['.gitignore', text('ignore')],
  ['.gitattributes', text()],
  ['.dockerignore', text('ignore')],
  ['.npmignore', text('ignore')],
  ['.editorconfig', text('ini')],
  ['.prettierrc', text('json')],
  ['.eslintrc', text('json')],
  ['.babelrc', text('json')],
  ['.nvmrc', text()],
  ['.zshrc', text('bash')],
  ['.bashrc', text('bash')],
  ['.profile', text('bash')],
]);

/** The basename of a relative path ("a/b/c.ts" gives "c.ts"). */
export function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

/** The lower-cased extension without the dot; '' for none and for dot names like ".zshrc". */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** Kind and language from the name, or null when only the content can tell. */
export function kindOf(name: string): KindInfo | null {
  const lower = name.toLowerCase();
  const byName = BY_NAME.get(lower);
  if (byName) return byName;
  const ext = extOf(name);
  if (ext === '') return null;
  return BY_EXT.get(ext) ?? null;
}

/** Kinds whose name is enough: the content is never sniffed for them. */
export function trustsName(kind: FileKind): boolean {
  return kind === 'image' || kind === 'pdf' || kind === 'binary';
}
