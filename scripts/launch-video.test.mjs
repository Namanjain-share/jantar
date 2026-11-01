// node --test scripts/
// The launch film and the README's GIF (scripts/launch-video.mjs), without
// rendering anything: the scenes and their words keep the site's copy rules
// and say only what this version does, every capture a scene shows is taken,
// the stage loads nothing from a network, the phone cut's words are large
// enough to read on a phone, and the committed files in docs/brand are the
// right kind, size and shape (MP4s with their index first, WebMs, a 1920 x
// 1080 and a 1080 x 1920 poster, two looping GIFs), each cut within the
// site's 6 MB and each GIF within GitHub's 8 MB. Rendering needs a Chromium, ffmpeg and a built web app:
// node scripts/launch-video.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FILM, FILM_NARROW, GIF, GIF_CUT, GIF_NARROW, LAYOUTS, LIMITS, OUT, POSTER_AT, SCENES, SHOTS, SITE_HOST, checkScript, cliCommands, endCard, readVersion } from './launch-video.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'launch-video.mjs');
const repo = join(dirname(script), '..');
const stageDir = join(dirname(script), 'launch-video');
const file = (k) => join(repo, OUT[k]);

test('the script as written passes its own checks', () => {
  assert.deepEqual(checkScript(), []);
  const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /9 scenes \(53 s\), 6 GIF parts \(14 s\), 10 captures/);
});

test('the checks catch broken words, gaps and missing captures', () => {
  const scene = (over) => SCENES.map((s) => (s.id === 'S2' ? { ...s, ...over } : s));
  const cap = (lines) => scene({ captions: [{ from: 7.6, to: 11.8, lines }] });
  const found = (scenes, re, extra = {}) => assert.ok(checkScript({ scenes, ...extra }).some((p) => re.test(p)), `nothing matched ${re}`);
  found(cap(['x'.repeat(LIMITS.captionChars + 1)]), /over 44 characters/);
  found(cap(['one', 'two', 'three']), /1 to 2 lines/);
  found(cap(['Your phone — the answer']), /en or em dash/);
  found(cap(['Your phone answers!']), /exclamation/);
  found(cap(['A seamless way to answer']), /hype word/);
  found(cap(['Free and open source']), /open source/);
  found(scene({ captions: [{ from: 6, to: 8, lines: ['Early'] }] }), /not inside/);
  found(scene({ kicker: 'jantar teleport on' }), /jantar teleport is not a command/);
  found(scene({ shots: ['lock-screen'] }), /lock-screen, which is not captured/);
  found(scene({ start: 7.5 }), /starts at 7.5, not 7/);
  found(SCENES, /does not end where it starts/, { cut: GIF_CUT.map((g) => (g.id === 'G5' ? { ...g, from: 'S8' } : g)) });
});

test('a 40 to 60 second film and a 10 to 15 second GIF, both ending on the end card', () => {
  assert.equal(SCENES.at(-1).end, FILM.seconds);
  assert.ok(FILM.seconds >= 40 && FILM.seconds <= 60);
  assert.equal(GIF_CUT.at(-1).end, GIF.seconds);
  assert.ok(GIF.seconds >= 10 && GIF.seconds <= 15);
  assert.equal(SCENES.at(-1).id, 'S9');
  assert.equal(GIF_CUT[0].from, 'S9');
  assert.equal(GIF_CUT.at(-1).from, 'S9');
  assert.ok(FILM.fps >= 24 && GIF.fps >= 12 && GIF.fps <= 15);
  assert.ok(POSTER_AT > 0 && POSTER_AT < FILM.seconds);
});

test('every product scene carries the Example data rail; the end card says so for the whole film', () => {
  for (const s of [...SCENES, ...GIF_CUT]) assert.equal(s.product, s.from !== 'S9' && s.id !== 'S9', `${s.id}: product`);
  const end = endCard();
  assert.match(end.foot, /^Example data throughout\./);
  assert.match(end.foot, /Not affiliated with Anthropic\./);
});

test('the words say only what this version does', () => {
  const words = [...SCENES, ...GIF_CUT].flatMap((s) => [s.kicker ?? '', ...s.captions.flatMap((c) => c.lines)]).join('\n');
  // Mac and Terminal.app only today: nothing from v0.6 or later, and no account switching.
  assert.doesNotMatch(words, /\b(?:linux|servers?|tmux|iterm2?|ghostty|windows|ssh)\b/i);
  assert.doesNotMatch(words, /\bswitch(?:es|ing)? (?:between )?accounts?\b|\bmoves? (?:a |the )?sessions?\b/i);
  // The kickers are real commands.
  const commands = cliCommands();
  for (const s of SCENES.filter((x) => x.kicker?.startsWith('jantar '))) assert.ok(commands.includes(s.kicker.split(' ')[1]), s.kicker);
  // Meetings: the summary, never the transcript's screenshots (not yet confirmed on a real call).
  const meeting = SHOTS.find((s) => s.name === 'meeting');
  assert.match(meeting.path, /^\/meetings\?id=/);
  assert.equal(meeting.steps, undefined);
  const end = endCard();
  assert.equal(end.meta, `Free · source-available (FSL-1.1-MIT) · v${readVersion()} · macOS and Terminal.app`);
  assert.equal(end.url, SITE_HOST);
  assert.equal(SITE_HOST, 'jantar.namanbuilt.com');
});

test('every capture is of the real app on the film fixture, at night, phone or desktop', () => {
  const names = new Set();
  for (const s of SHOTS) {
    assert.ok(!names.has(s.name), `${s.name} twice`);
    names.add(s.name);
    assert.ok(['before', 'answered', 'migrating', 'testing', 'done'].includes(s.stage), s.name);
    assert.ok([390, 1440].includes(s.size.width), s.name);
    assert.equal(s.size.scale, 2, s.name);
  }
  for (const s of SCENES) for (const n of s.shots) assert.ok(names.has(n), `${s.id}: ${n}`);
});

test("the phone cut tells the same story at the same times, in words a phone can read", () => {
  // The same scenes and seconds, so the site can swap one cut for the other mid-play.
  assert.equal(FILM_NARROW.seconds, FILM.seconds);
  assert.equal(FILM_NARROW.fps, FILM.fps);
  assert.ok(FILM_NARROW.height > FILM_NARROW.width, 'portrait');
  assert.deepEqual([GIF_NARROW.seconds, GIF_NARROW.fps], [GIF.seconds, GIF.fps]);
  assert.ok(GIF_NARROW.height > GIF_NARROW.width, 'portrait');
  assert.deepEqual(Object.keys(LAYOUTS).sort(), ['film', 'film-narrow', 'gif', 'gif-narrow']);
  for (const { files } of Object.values(LAYOUTS)) for (const k of files) assert.ok(OUT[k], k);
  // Shown 358 px wide (a 390 px phone less the page's gutters): captions of 64 px and a rail of 28 px or more read at about 21 and 9 px.
  const js = readFileSync(join(stageDir, 'stage.js'), 'utf8');
  const narrow = js.slice(js.indexOf('function narrowLayout()'), js.indexOf('const L = NARROW'));
  const px = (name) => Number(new RegExp(`'${name}': '([\\d.]+)px'`).exec(narrow)?.[1]);
  const shown = (v) => (v * 358) / FILM_NARROW.width;
  assert.ok(px('--cap-size') >= 64 && shown(px('--cap-size')) >= 21, `captions ${px('--cap-size')} px`);
  assert.ok(px('--cap-big-size') >= 64, `big captions ${px('--cap-big-size')} px`);
  assert.ok(px('--rail-size') >= 28 && shown(px('--rail-size')) >= 9, `rail ${px('--rail-size')} px`);
  assert.ok(px('--kicker-size') >= 28, `kicker ${px('--kicker-size')} px`);
  assert.ok(px('--term-size') >= 24, `Terminal text ${px('--term-size')} px`);
  // The GIF is drawn from the same layout at its scale: at 358 px its captions too stay over 20 px.
  assert.ok((px('--cap-size') * GIF_NARROW.scale * 358) / (GIF_NARROW.width * GIF_NARROW.scale) >= 21);
});

test('the stage loads nothing from a network and runs on no clock', () => {
  for (const f of ['stage.html', 'stage.css', 'stage.js']) {
    const text = readFileSync(join(stageDir, f), 'utf8');
    assert.doesNotMatch(text, /https?:\/\//, `${f} names a URL`);
    assert.doesNotMatch(text, /@import|url\(\s*['"]?(?!data:)/, `${f} loads a file`);
  }
  const js = readFileSync(join(stageDir, 'stage.js'), 'utf8');
  assert.doesNotMatch(js, /\b(?:Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame|Math\.random)\b/, 'the same t must draw the same frame');
  assert.doesNotMatch(js, /\bfetch\(|XMLHttpRequest|WebSocket/);
  const html = readFileSync(join(stageDir, 'stage.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(['fonts.css', 'tokens.css', 'stage.css', 'data.js', 'stage.js'].includes(m[1]), m[1]);
});

// ---------------------------------------------------------------------------
// The committed files

const have = Object.keys(OUT).every((k) => existsSync(file(k)));

/** Top-level MP4 boxes, in order. */
function boxes(buf) {
  const out = [];
  for (let at = 0; at + 8 <= buf.length; ) {
    let len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (len === 1) len = Number(buf.readBigUInt64BE(at + 8));
    if (len === 0) len = buf.length - at;
    if (len < 8) break;
    out.push(type);
    at += len;
  }
  return out;
}

/** A baseline or progressive JPEG's size. */
function jpegSize(buf) {
  assert.equal(buf.readUInt16BE(0), 0xffd8, 'not a JPEG');
  for (let at = 2; at < buf.length; ) {
    const marker = buf.readUInt16BE(at);
    const len = buf.readUInt16BE(at + 2);
    if (marker === 0xffc0 || marker === 0xffc2) return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    at += 2 + len;
  }
  throw new Error('no frame header');
}

/** A cut of the film: an H.264 MP4 with its index first and no sound, a VP9 WebM and a poster of the cut's size, 6 MB in all. */
function checkCut([kMp4, kWebm, kPoster], size) {
  const mp4 = readFileSync(file(kMp4));
  const top = boxes(mp4);
  assert.equal(top[0], 'ftyp');
  assert.ok(top.indexOf('moov') >= 0 && top.indexOf('moov') < top.indexOf('mdat'), `faststart: moov before mdat (${top.join(' ')})`);
  assert.ok(mp4.includes(Buffer.from('avc1')), 'H.264');
  assert.ok(!mp4.includes(Buffer.from('soun')), 'no sound track');
  const webm = readFileSync(file(kWebm));
  assert.equal(webm.readUInt32BE(0), 0x1a45dfa3, 'EBML');
  assert.ok(webm.includes(Buffer.from('webm')) && webm.includes(Buffer.from('V_VP9')), 'VP9 in WebM');
  assert.deepEqual(jpegSize(readFileSync(file(kPoster))), { width: size.width, height: size.height });
  const total = [kMp4, kWebm, kPoster].reduce((n, k) => n + statSync(file(k)).size, 0);
  assert.ok(total <= LIMITS.site, `${OUT[kMp4]} and the rest are ${total} bytes, over ${LIMITS.site}`);
}

test('the film: an H.264 MP4 with its index first, a VP9 WebM and a 1920 x 1080 poster, 6 MB in all', { skip: !have && 'not rendered yet' }, () => {
  checkCut(LAYOUTS.film.files, FILM);
});

test('the phone cut: the same, 1080 x 1920, 6 MB in all, and lighter than the wide film', { skip: !have && 'not rendered yet' }, () => {
  checkCut(LAYOUTS['film-narrow'].files, FILM_NARROW);
  const bytes = (keys) => keys.reduce((n, k) => n + statSync(file(k)).size, 0);
  assert.ok(bytes(['mp4Narrow', 'webmNarrow']) < bytes(['mp4', 'webm']), 'a phone loads less than a wide screen');
});

test("the README's GIFs: 1280 x 720 and 720 x 900, looping, each under 8 MB", { skip: !have && 'not rendered yet' }, () => {
  for (const [k, size] of [['gif', GIF], ['gifNarrow', GIF_NARROW]]) {
    const gif = readFileSync(file(k));
    assert.equal(gif.toString('latin1', 0, 6), 'GIF89a', k);
    assert.deepEqual([gif.readUInt16LE(6), gif.readUInt16LE(8)], [Math.round(size.width * size.scale), Math.round(size.height * size.scale)], k);
    assert.ok(gif.includes(Buffer.from('NETSCAPE2.0')), `${k} loops`);
    assert.ok(gif.length <= LIMITS.gif, `${k}: ${gif.length} bytes, over ${LIMITS.gif}`);
  }
});
