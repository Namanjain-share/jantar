/**
 * The pairing QR: one SVG path (no data: URLs, so the CSP holds), always
 * black on white in a 12 px padded white card with the dock radius, in both
 * themes, so any phone camera can read it.
 */
import { useMemo } from 'react';
import QRCode from 'qrcode';

/** Two modules of white inside the SVG; with the card's 12 px padding that is about the 4-module quiet zone. */
const QUIET = 2;

export function QrPath({ text, size = 220, label }: { text: string; size?: number; label: string }) {
  const { d, n } = useMemo(() => {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    let path = '';
    for (let r = 0; r < count; r += 1) {
      for (let c = 0; c < count; c += 1) {
        if (qr.modules.get(r, c)) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
      }
    }
    return { d: path, n: count + QUIET * 2 };
  }, [text]);
  return (
    <svg className="block" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect className="fill-qr-paper" width={n} height={n} />
      <path className="fill-qr-ink" d={d} />
    </svg>
  );
}

/** 220 px of code inside 12 px of white: the quiet zone the camera needs. */
export function QrCard({ text, label, dim = false }: { text: string; label: string; dim?: boolean }) {
  return (
    <div className={dim ? 'w-fit rounded-dock bg-qr-paper p-12 opacity-20' : 'w-fit rounded-dock bg-qr-paper p-12'}>
      <QrPath text={text} label={label} />
    </div>
  );
}
