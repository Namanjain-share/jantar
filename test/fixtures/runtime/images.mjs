// Real, decodable images for the fake screencapture and sips, with no
// dependency: an 8-bit RGB PNG (one flat colour, or noise that does not
// compress) and a baseline grayscale JPEG of any size (flat mid-grey).
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A width x height RGB PNG: a flat colour (tiny file) or, with `noise`, random pixels stored uncompressed (about 3 bytes a pixel). */
export function makePng(width, height, { noise = false, rgb = [0x1e, 0x1e, 0x2e] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const stride = width * 3 + 1;
  let raw;
  if (noise) {
    raw = randomBytes(stride * height);
    for (let y = 0; y < height; y++) raw[y * stride] = 0; // filter: none
  } else {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
    raw = Buffer.concat(new Array(height).fill(row));
  }
  const idat = deflateSync(raw, { level: noise ? 0 : 6 });
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function segment(marker, body) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/**
 * A baseline grayscale JPEG, flat mid-grey. Both Huffman tables hold one
 * 1-bit code (DC difference 0, AC end-of-block), so every 8x8 block is two
 * zero bits. `padBytes` adds comment segments to make the file bigger.
 */
export function makeJpeg(width, height, { padBytes = 0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0])));
  parts.push(segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)])));
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1; // one component
  sof[6] = 1; // component id
  sof[7] = 0x11; // no subsampling
  sof[8] = 0; // quant table 0
  parts.push(segment(0xc0, sof));
  const oneCode = Buffer.concat([Buffer.from([1]), Buffer.alloc(15), Buffer.from([0x00])]);
  parts.push(segment(0xc4, Buffer.concat([Buffer.from([0x00]), oneCode]))); // DC table 0
  parts.push(segment(0xc4, Buffer.concat([Buffer.from([0x10]), oneCode]))); // AC table 0
  for (let left = padBytes; left > 0; left -= 65533) parts.push(segment(0xfe, Buffer.alloc(Math.min(left, 65533), 0x20)));
  parts.push(segment(0xda, Buffer.from([1, 1, 0x00, 0, 63, 0])));
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const bits = blocks * 2;
  const scan = Buffer.alloc(Math.ceil(bits / 8));
  const used = bits % 8;
  if (used) scan[scan.length - 1] = 0xff >> used; // pad the last byte with 1 bits
  parts.push(scan, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** Format and size of a PNG or JPEG, or null for anything else. */
export function imageInfo(buf) {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    // off + 9: a frame header's width ends at off + 8, so a cut-off file stops here instead of throwing
    while (off + 9 <= buf.length && buf[off] === 0xff) {
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5) };
      }
      off += 2 + buf.readUInt16BE(off + 2);
    }
  }
  return null;
}

/** Whether a PNG holds noise: its pixel data barely compressed. */
export function pngIsNoise(buf) {
  const info = imageInfo(buf);
  return info !== null && info.format === 'png' && buf.length > info.width * info.height * 1.5;
}
