/**
 * A Jupyter notebook (.ipynb, nbformat 4) read as data, never as markup:
 * code cells keep their source, markdown cells their text, and outputs are
 * reduced to text, a PNG or JPEG (still base64), or a label for anything
 * that would need HTML or script to show (spec 5.2.3).
 *
 * Only fixed keys are read from the parsed JSON, through own-property
 * checks, so a notebook with "__proto__" or "constructor" keys is just data.
 */

export type NotebookOutput =
  | { kind: 'text'; text: string; error?: boolean }
  | { kind: 'image'; mime: 'image/png' | 'image/jpeg'; base64: string }
  | { kind: 'hidden'; label: string };

export type NotebookCell =
  | { kind: 'code'; source: string; count: number | null; outputs: NotebookOutput[] }
  | { kind: 'markdown'; source: string }
  | { kind: 'raw'; source: string };

export interface Notebook {
  /** The kernel's language ("python"), when the notebook says. */
  language: string | null;
  cells: NotebookCell[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** nbformat stores text as a string or a list of lines. */
function joined(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').join('');
  return '';
}

/** Terminal colour codes in tracebacks. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const HTML_MIMES = ['text/html', 'application/javascript', 'text/javascript', 'application/vnd.jupyter.widget-view+json'];

function output(o: Obj): NotebookOutput | null {
  const type = own(o, 'output_type');
  if (type === 'stream') return { kind: 'text', text: joined(own(o, 'text')) };
  if (type === 'error') {
    const tb = own(o, 'traceback');
    const text = Array.isArray(tb) ? joined(tb.map((l) => (typeof l === 'string' ? `${l}\n` : ''))) : `${String(own(o, 'ename') ?? 'Error')}: ${String(own(o, 'evalue') ?? '')}`;
    return { kind: 'text', text: text.replace(ANSI, ''), error: true };
  }
  if (type !== 'execute_result' && type !== 'display_data') return null;
  const data = own(o, 'data');
  if (!isObj(data)) return null;
  for (const mime of ['image/png', 'image/jpeg'] as const) {
    const b64 = joined(own(data, mime));
    if (b64) return { kind: 'image', mime, base64: b64 };
  }
  const plain = joined(own(data, 'text/plain'));
  if (plain) return { kind: 'text', text: plain };
  if (HTML_MIMES.some((m) => own(data, m) !== undefined)) return { kind: 'hidden', label: 'HTML output not shown' };
  if (own(data, 'image/svg+xml') !== undefined) return { kind: 'hidden', label: 'SVG output not shown' };
  return { kind: 'hidden', label: 'Output not shown' };
}

/** Parse a notebook; null when the text is not one. */
export function parseNotebook(text: string): Notebook | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(doc)) return null;
  const rawCells = own(doc, 'cells');
  if (!Array.isArray(rawCells)) return null;
  const meta = own(doc, 'metadata');
  const info = isObj(meta) ? own(meta, 'language_info') : undefined;
  const kernel = isObj(meta) ? own(meta, 'kernelspec') : undefined;
  const lang = (isObj(info) ? own(info, 'name') : undefined) ?? (isObj(kernel) ? own(kernel, 'language') : undefined);

  const cells: NotebookCell[] = [];
  for (const c of rawCells) {
    if (!isObj(c)) continue;
    const source = joined(own(c, 'source'));
    const type = own(c, 'cell_type');
    if (type === 'markdown') cells.push({ kind: 'markdown', source });
    else if (type === 'code') {
      const outs = own(c, 'outputs');
      const count = own(c, 'execution_count');
      cells.push({
        kind: 'code',
        source,
        count: typeof count === 'number' ? count : null,
        outputs: Array.isArray(outs) ? outs.filter(isObj).map(output).filter((x): x is NotebookOutput => x !== null) : [],
      });
    } else cells.push({ kind: 'raw', source });
  }
  return { language: typeof lang === 'string' ? lang : null, cells };
}
