/**
 * Screenshot fixtures: knobs for the fake `screencapture` and `sips`
 * built-ins (runtime/fake-bin.mjs) and an image reader for assertions.
 *
 *   await setFakeScreencapture(home, { windows: { '4242': { width: 2880, height: 1800, noise: true } } });
 *   const r = await exec(home.bins.screencapture, ['-x', '-o', '-a', '-r', '-l', '4242', '-t', 'png', tmp]);
 *   await exec(home.bins.sips, ['-Z', '1600', tmp]);           // a real PNG, now 1600x1000
 *   imageInfo(await readFile(tmp));                            // { format: 'png', width: 1600, height: 1000 }
 *
 * screencapture writes a real PNG (or JPEG with -t jpg) of the window's size;
 * sips answers -g queries, fits with -Z (never enlarging), converts with
 * `-s format jpeg`, and writes in place or to --out. Noise stays noise, so a
 * big capture stays big after resizing (the JPEG fallback over 1.5 MB). Both
 * refuse to write outside the system temp dir. Rules set with setRules()
 * still win over the built-ins (failures, delays).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FakeHome } from './home.js';

export interface FakeWindowShot {
  width?: number;
  height?: number;
  /** Random pixels (about 3 bytes a pixel) instead of a flat colour (a few KB). */
  noise?: boolean;
  /** screencapture fails: "could not create image from window". */
  missing?: boolean;
}

export interface FakeScreencaptureOptions extends Omit<FakeWindowShot, 'missing'> {
  /** By window id (`-l <wid>`). */
  windows?: Record<string, FakeWindowShot>;
}

/** Default capture: 2880x1800, flat colour; per-window overrides by id. */
export async function setFakeScreencapture(home: FakeHome, opts: FakeScreencaptureOptions): Promise<void> {
  await writeFile(join(home.root, 'fake', 'screencapture.options.json'), `${JSON.stringify(opts)}\n`);
}

/** `jpegPadBytes` makes every JPEG sips writes that much bigger (to push past the 2 MB cap). */
export async function setFakeSips(home: FakeHome, opts: { jpegPadBytes?: number }): Promise<void> {
  await writeFile(join(home.root, 'fake', 'sips.options.json'), `${JSON.stringify(opts)}\n`);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Format and size of a PNG or JPEG (from its header), or null. */
export function imageInfo(buf: Buffer): { format: 'png' | 'jpeg'; width: number; height: number } | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 <= buf.length && buf[off] === 0xff) {
      const marker = buf[off + 1] as number;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}
