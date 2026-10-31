/**
 * An SVG (v0.3 spec 5.2.3): its source by default, since an SVG is a
 * document that can hold scripts. "Preview" builds a Blob from the text the
 * daemon already sent as JSON (never from /v1/files/raw, which refuses SVG)
 * and shows it as <img src=blob:>, where scripts never run. The object URL
 * is revoked as soon as the image has loaded, and again (harmlessly) when
 * the preview closes or the view unmounts.
 */
import { useMemo } from 'react';
import { Segmented } from '../accounts/Segmented.js';
import { useObjectUrl } from './blob.js';
import { CodeView } from './CodeView.js';
import type { LineRange } from './model.js';
import { StateLine } from './states.js';
import type { FileTextState } from './text.js';

export function SvgView({
  t,
  name,
  mode,
  onMode,
  sel,
  onLine,
}: {
  t: FileTextState;
  name: string;
  mode: 'source' | 'preview';
  onMode: (m: 'source' | 'preview') => void;
  sel: LineRange | null;
  onLine: (n: number) => void;
}) {
  // A cut-off SVG is not an image: preview only the whole file.
  const whole = t.first !== null && t.next === null;
  const blob = useMemo(() => (mode === 'preview' && whole ? new Blob([t.text], { type: 'image/svg+xml' }) : null), [mode, whole, t.text]);
  const url = useObjectUrl(blob);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-16 py-8">
        <Segmented
          label="Show the SVG as"
          value={mode}
          onChange={onMode}
          segments={[
            { key: 'source', label: 'Source' },
            { key: 'preview', label: 'Preview' },
          ]}
        />
      </div>
      {/* The code view also owns the loading and error states, in both modes. */}
      {mode === 'source' || !t.first ? (
        <CodeView t={t} name={name} lang="markup" sel={sel} onLine={onLine} />
      ) : !whole ? (
        <StateLine>This SVG is too large to preview. Its source shows under Source.</StateLine>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-16 md:p-24">
          {/* Revoked once painted (the image stays): "Open in New Tab" on a long press then finds no same-origin SVG document to load. */}
          {url ? <img src={url} alt={name} className="mx-auto h-auto max-w-full" onLoad={() => URL.revokeObjectURL(url)} /> : null}
        </div>
      )}
    </div>
  );
}
