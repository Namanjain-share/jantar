// Types for images.mjs, so the fixtures' TypeScript (meetings.ts) can build on the same generated images.

/** A width x height RGB PNG: a flat colour (tiny file) or, with `noise`, random pixels stored uncompressed. */
export function makePng(width: number, height: number, opts?: { noise?: boolean; rgb?: readonly [number, number, number] }): Buffer;
/** A baseline grayscale JPEG, flat mid-grey; `padBytes` adds comment segments to make the file bigger. */
export function makeJpeg(width: number, height: number, opts?: { padBytes?: number }): Buffer;
/** Format and size of a PNG or JPEG, or null for anything else. */
export function imageInfo(buf: Buffer): { format: 'png' | 'jpeg'; width: number; height: number } | null;
/** Whether a PNG holds noise: its pixel data barely compressed. */
export function pngIsNoise(buf: Buffer): boolean;
