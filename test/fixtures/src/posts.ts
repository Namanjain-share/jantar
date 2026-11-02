/**
 * v0.8 (Intel reads links): synthetic post pages for the in-page reader
 * (`@jantar/protocol/page-read`) and the extension's read loop. Each is a
 * whole HTML document shaped like the platform's own page as a signed-in
 * user sees it (the post's container and selectors, a nav, a header and an
 * account menu), with every value made up: creators like @example_cook,
 * links on example.com, media on the platforms' CDN hosts with synthetic
 * paths. SIGNED_IN_MARKER is the signed-in user's name, planted only where
 * the post is not (the nav, the account menu, the comment box's avatar): a
 * read must never hold it. POST_MARKER rides in a caption and a link for
 * the privacy sweeps (G12).
 *
 *   const page = POST_PAGES.instagram;      // { url, html, caption, author }
 *   const dom = new JSDOM(page.html, { url: page.url });
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The signed-in user's name, as the page shows it outside the post. Never in a read. */
export const SIGNED_IN_MARKER = 'SYNTHETIC-SIGNED-IN-USER-9271';
/** Put in captions, links and transcripts that must never reach logs, audit, events or error sentences. */
export const POST_MARKER = 'SYNTHETIC-POST-TEXT-DO-NOT-LOG';

export type PostPageName = 'instagram' | 'instagramLogin' | 'youtube' | 'tiktok' | 'x' | 'reddit' | 'linkedin' | 'web' | 'notFound';

export interface PostPage {
  /** The URL the page is served at (a real post shape on the platform's www host; the web page on example.com). */
  url: string;
  html: string;
  /** What the read's text must hold (the post's own words). */
  caption: string;
  /** The read's author, when the page names one. */
  author?: string;
  handle?: string;
}

/** A 1x1 JPEG as a data URL (synthetic). */
export const TINY_JPEG_DATA_URL =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const head = (title: string, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extra}</head>`;

/** What every signed-in page has around the post: a nav naming the user and an account menu. */
const chrome = (profileHref: string) =>
  `<nav aria-label="Primary"><a href="${profileHref}">${SIGNED_IN_MARKER}</a><img alt="${SIGNED_IN_MARKER}'s profile picture" src="https://static.example.com/avatar-${SIGNED_IN_MARKER}.jpg" width="300" height="300"></nav>` +
  `<div role="menu" aria-label="Account"><span>Signed in as ${SIGNED_IN_MARKER}</span></div>`;

const IG_CAPTION = 'Three ways to cook dal at home. Soak overnight, then pressure cook with turmeric.';
const YT_DESCRIPTION = 'A synthetic walk-through of a small kitchen garden, from seeds to the first harvest.';
const TT_CAPTION = 'Synthetic street food in sixty seconds #example';
const X_TEXT = 'A synthetic post about shipping small things often. Link: https://example.com/notes';
const REDDIT_BODY = 'What is the simplest way to back up a home server? Asking for a synthetic friend.';
const LI_TEXT = 'We shipped a synthetic feature today. Three things we learned about small teams.';
const WEB_BODY = 'This synthetic article explains how to keep a small notebook of ideas. ';

export const POST_PAGES: Readonly<Record<PostPageName, PostPage>> = Object.freeze({
  instagram: {
    url: 'https://www.instagram.com/reel/AbC123xyz/',
    caption: IG_CAPTION,
    author: 'example_cook',
    handle: 'example_cook',
    html:
      head(
        'Example Cook on Instagram: "Three ways to cook dal at home."',
        '<meta property="og:title" content="Example Cook on Instagram: &quot;Three ways to cook dal at home.&quot;">' +
          '<meta property="og:url" content="https://www.instagram.com/example_cook/reel/AbC123xyz/">' +
          '<meta property="og:image" content="https://scontent.cdninstagram.com/v/synthetic/cover.jpg">' +
          '<meta name="description" content="120 likes, 4 comments - example_cook on October 30, 2026">',
      ) +
      `<body>${chrome('/synthetic_signed_in/')}<main><article>` +
      '<header><a href="/example_cook/" role="link">example_cook</a></header>' +
      '<video src="blob:https://www.instagram.com/synthetic" poster="https://scontent.cdninstagram.com/v/synthetic/poster.jpg"></video>' +
      `<div><span dir="auto"><h1>${IG_CAPTION}</h1></span></div>` +
      '<time datetime="2026-10-30T08:00:00.000Z">Oct 30</time>' +
      '<img alt="Post image" src="https://scontent.cdninstagram.com/v/synthetic/slide1.jpg" width="1080" height="1350">' +
      `<section><img alt="${SIGNED_IN_MARKER}'s profile picture" src="https://scontent.cdninstagram.com/v/synthetic/me.jpg" width="32" height="32"><textarea placeholder="Add a comment…"></textarea></section>` +
      '</article></main>' +
      '<script type="application/json">{"items":[{"video_versions":[{"type":101,"url":"https:\\/\\/scontent.cdninstagram.com\\/v\\/synthetic\\/reel.mp4?a=1\\u0026b=2","width":720}]}]}</script>' +
      '<script type="application/json">{"other":[{"video_versions":[{"url":"https:\\/\\/evil.example\\/x.mp4"}]}]}</script>' +
      '</body></html>',
  },
  instagramLogin: {
    url: 'https://www.instagram.com/reel/AbC123xyz/',
    caption: '',
    html:
      head('Instagram') +
      '<body><main><div><form><input name="username"><input type="password" name="password"><button>Log in</button></form></div></main></body></html>',
  },
  youtube: {
    url: 'https://www.youtube.com/watch?v=Ab3dE6gH9jK',
    caption: YT_DESCRIPTION,
    author: 'Example Garden',
    html:
      head(
        '(3) A synthetic kitchen garden - YouTube',
        '<meta property="og:title" content="A synthetic kitchen garden"><meta itemprop="datePublished" content="2026-10-01T10:00:00-07:00">',
      ) +
      `<body><div id="masthead">${chrome('/@synthetic_signed_in')}</div><ytd-watch-flexy><div id="primary"><video src="blob:https://www.youtube.com/synthetic"></video>` +
      '<ytd-watch-metadata><h1><yt-formatted-string>A synthetic kitchen garden</yt-formatted-string></h1>' +
      '<div id="owner"><ytd-channel-name><a href="/@example_garden">Example Garden</a></ytd-channel-name></div>' +
      `<div id="description-inline-expander">${YT_DESCRIPTION}</div></ytd-watch-metadata>` +
      `</div><div id="secondary"><a href="/watch?v=Zz9yX8wV7uT">Up next: something else</a></div></ytd-watch-flexy></body></html>`,
  },
  tiktok: {
    url: 'https://www.tiktok.com/@example_food/video/7300000000000000001',
    caption: TT_CAPTION,
    author: 'example_food',
    html:
      head('Synthetic street food | TikTok') +
      `<body>${chrome('/@synthetic_signed_in')}<main><div data-e2e="browse-video"><video src="blob:https://www.tiktok.com/synthetic"></video>` +
      `<a href="/@example_food" data-e2e="browse-username">example_food</a><div data-e2e="browse-video-desc">${TT_CAPTION}</div></div></main></body></html>`,
  },
  x: {
    url: 'https://x.com/example_dev/status/1850000000000000001',
    caption: X_TEXT,
    author: 'Example Dev',
    handle: 'example_dev',
    html:
      head('(2) Example Dev on X: "A synthetic post about shipping small things often." / X') +
      `<body><header role="banner">${chrome('/synthetic_signed_in')}</header><main>` +
      '<article data-testid="tweet"><div data-testid="User-Name"><span>Someone Else</span><a href="/someone_else">@someone_else</a></div>' +
      '<div data-testid="tweetText">A reply above the post, not the post.</div><a href="/someone_else/status/1840000000000000009"><time datetime="2026-10-29T08:00:00.000Z">Oct 29</time></a></article>' +
      '<article data-testid="tweet"><div data-testid="User-Name"><span>Example Dev</span><a href="/example_dev">@example_dev</a></div>' +
      `<div data-testid="tweetText">${X_TEXT}</div>` +
      '<div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/SyntheticA.jpg" width="1200" height="675"></div>' +
      '<a href="/example_dev/status/1850000000000000001"><time datetime="2026-10-30T09:15:00.000Z">Oct 30</time></a></article>' +
      `<div data-testid="reply-box"><img alt="${SIGNED_IN_MARKER}" src="https://pbs.twimg.com/profile_images/synthetic.jpg" width="40"><span>Post your reply</span></div>` +
      '</main></body></html>',
  },
  reddit: {
    url: 'https://www.reddit.com/r/selfhosted/comments/abc123/simple_backups/',
    caption: REDDIT_BODY,
    author: 'example_admin',
    html:
      head('Simple backups : r/selfhosted') +
      `<body><reddit-header-large>${chrome('/user/synthetic_signed_in/')}</reddit-header-large><main>` +
      `<shreddit-post post-title="Simple backups for a home server" author="example_admin" created-timestamp="2026-10-28T12:00:00.000Z"><div slot="text-body"><p>${REDDIT_BODY}</p></div></shreddit-post>` +
      '<shreddit-comment depth="0" author="example_helper"><div slot="comment"><p>Use one tool and test restores.</p></div></shreddit-comment>' +
      '<shreddit-comment depth="1" author="example_nested"><div slot="comment"><p>A nested reply.</p></div></shreddit-comment>' +
      '<shreddit-comment depth="0" author="example_second"><div slot="comment"><p>Two copies, one off site.</p></div></shreddit-comment>' +
      `<div class="comment-composer"><span>Comment as ${SIGNED_IN_MARKER}</span></div>` +
      '</main></body></html>',
  },
  linkedin: {
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000002/',
    caption: LI_TEXT,
    author: 'Example Founder',
    html:
      head('(5) Post | LinkedIn') +
      `<body><header class="global-nav">${chrome('/in/synthetic-signed-in/')}<div class="global-nav__me">Me ${SIGNED_IN_MARKER}</div></header><main>` +
      '<div class="feed-shared-update-v2" data-urn="urn:li:activity:7300000000000000002">' +
      '<div class="update-components-actor"><span class="update-components-actor__title"><span aria-hidden="true">Example Founder</span></span>' +
      '<span class="update-components-actor__sub-description"><span aria-hidden="true">2d</span></span></div>' +
      `<div class="update-components-text"><span>${LI_TEXT}</span></div>` +
      '<img src="https://media.licdn.com/dms/image/synthetic/post.jpg" width="1200" height="627" alt="">' +
      '<article class="comments-comment-item"><span class="comments-post-meta__name-text">Example Reader</span><div class="comments-comment-item__main-content">Congrats on shipping.</div></article>' +
      `<div class="comments-comment-box"><img alt="${SIGNED_IN_MARKER}" src="https://media.licdn.com/dms/image/synthetic/me.jpg" width="40" height="40"><div contenteditable="true">Add a comment…</div></div>` +
      '</div></main></body></html>',
  },
  web: {
    url: 'https://example.com/blog/small-notebook',
    caption: WEB_BODY.trim(),
    author: 'Example Writer',
    html:
      head(
        'A small notebook of ideas',
        '<meta name="author" content="Example Writer"><meta property="article:published_time" content="2026-10-20T07:00:00Z"><meta property="og:image" content="https://example.com/cover.jpg">',
      ) +
      `<body><header><a href="/account">${SIGNED_IN_MARKER}</a></header><nav>Home · Blog · About</nav>` +
      `<article><header><h1>A small notebook of ideas</h1></header><p>${WEB_BODY.repeat(4)}</p><p>Second paragraph.</p>` +
      `<aside>Related: something else</aside><script>window.x = "${SIGNED_IN_MARKER}"</script><footer>© Example</footer></article>` +
      `<footer>Signed in as ${SIGNED_IN_MARKER}</footer></body></html>`,
  },
  notFound: {
    url: 'https://www.instagram.com/p/Gone12345/',
    caption: '',
    html: head('Page not found • Instagram') + "<body><main><div><h2>Sorry, this page isn't available.</h2></div></main></body></html>",
  },
});

/**
 * v0.8: a fake `yt-dlp` (runtime/fake-bin.mjs `builtinYtDlp`) written as
 * `<dir>/yt-dlp` for the fake home at `root`; calls go to
 * <root>/calls/yt-dlp.jsonl and <root>/fake/yt-dlp.json answers first. Put
 * it in `<home>/.local/bin`, where Jantar looks first. Returns its path.
 */
export async function writeFakeYtDlp(root: string, dir: string): Promise<string> {
  const runtime = fileURLToPath(new URL('../runtime/fake-bin.mjs', import.meta.url));
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'yt-dlp');
  await writeFile(path, `#!${process.execPath}\nimport { run } from ${JSON.stringify(runtime)};\nawait run({ name: 'yt-dlp', root: ${JSON.stringify(root)} });\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

/** v0.8: the paths writeFakeMediaTools wrote, named as the daemon's Bins names them. */
export interface FakeMediaTools {
  xcodeSelect: string;
  swiftc: string;
  sandboxExec: string;
}

/**
 * v0.8: fake `xcode-select`, `swiftc` and `sandbox-exec` (runtime/fake-bin.mjs)
 * written into `dir` for the fake home at `root`, and `<root>/fake-clt/usr/bin/swiftc`
 * (what `xcode-select -p` points at). The fake swiftc "builds" a fake
 * `jantar-media` that answers every subcommand with synthetic output; the
 * fake sandbox-exec runs it with no sandbox. Nothing compiles Swift. Calls go
 * to <root>/calls/<name>.jsonl. A test puts these paths in the daemon's
 * bins (they have no settings: the real ones sit at fixed paths).
 */
export async function writeFakeMediaTools(root: string, dir: string): Promise<FakeMediaTools> {
  const runtime = fileURLToPath(new URL('../runtime/fake-bin.mjs', import.meta.url));
  const wrapper = (name: string) => `#!${process.execPath}\nimport { run } from ${JSON.stringify(runtime)};\nawait run({ name: ${JSON.stringify(name)}, root: ${JSON.stringify(root)} });\n`;
  const put = async (path: string, name: string) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, wrapper(name), { mode: 0o755 });
    await chmod(path, 0o755);
    return path;
  };
  await put(join(root, 'fake-clt', 'usr', 'bin', 'swiftc'), 'swiftc');
  return {
    xcodeSelect: await put(join(dir, 'xcode-select'), 'xcode-select'),
    swiftc: await put(join(dir, 'swiftc'), 'swiftc'),
    sandboxExec: await put(join(dir, 'sandbox-exec'), 'sandbox-exec'),
  };
}
