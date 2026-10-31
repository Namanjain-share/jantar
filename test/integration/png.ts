/**
 * A tiny PNG reader for screenshots taken by Chromium (8-bit RGB or RGBA,
 * not interlaced): enough to look at pixels in a test without a dependency.
 */
import { inflateSync } from 'node:zlib';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

export function decodePng(buf: Buffer): Pixels {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      if (depth !== 8 || body[12] !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${body[12]})`);
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (!channels) throw new Error(`unsupported PNG colour type ${colour}`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      const x = line[i]!;
      let v: number;
      switch (filter) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      cur[i] = v & 0xff;
    }
    for (let px = 0; px < width; px += 1) {
      const o = (y * width + px) * 4;
      out[o] = cur[px * channels]!;
      out[o + 1] = cur[px * channels + 1]!;
      out[o + 2] = cur[px * channels + 2]!;
      out[o + 3] = channels === 4 ? cur[px * channels + 3]! : 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

/** Rec. 709 luminance of one pixel, 0..255. */
export function luma(p: Pixels, x: number, y: number): number {
  const o = (y * p.width + x) * 4;
  return 0.2126 * p.data[o]! + 0.7152 * p.data[o + 1]! + 0.0722 * p.data[o + 2]!;
}
