# The website

The project's one-page site and the Meetings extension's privacy page,
static HTML and CSS with a little JavaScript for the theme switch and the
Copy buttons. Everything works with JavaScript off.

```sh
node scripts/build-site.mjs            # writes site/dist (git-ignored)
node scripts/build-site.mjs --serve    # the same, then serves it at http://127.0.0.1:<port>/jantar/
node --test scripts/build-site.test.mjs
```

`--no-resize` skips the WebP step and uses the PNGs as they are (quick, for
tests). `--out DIR` writes elsewhere, inside `site/` or the temp folder only.
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds and
deploys it on every push to `main` that touches what the site is made from.

## What is where

| File | What it holds |
|---|---|
| [`src/index.html`](src/index.html) | The page, with `{{...}}` values and `<x-...>` elements the build fills in |
| [`src/privacy.html`](src/privacy.html) | The Meetings extension's privacy page (served at `privacy/`) |
| [`src/header.html`](src/header.html), [`src/footer.html`](src/footer.html) | Shared by both pages |
| [`src/site.css`](src/site.css) | Layout and components. Colours are `var(--token)` only |
| [`src/site.js`](src/site.js) | The theme switch and the Copy buttons |
| [`src/theme-init.js`](src/theme-init.js) | Inlined into `<head>`; the CSP allows it by its hash |
| [`src/icons.svg`](src/icons.svg) | The four icons (Phosphor, MIT) |
| [`src/figures.json`](src/figures.json) | Every picture: its file in `docs/img/`, frame, widths, `sizes` and alt text |

## What the build reads

Nothing comes from the network, and the pages load nothing from another
server (a Content Security Policy allows `'self'` only).

- Colours: the day and night blocks of
  [`packages/web/src/styles/tokens.css`](../packages/web/src/styles/tokens.css),
  the web app's own, so the site and the app never drift apart.
- Fonts: Archivo and JetBrains Mono, the app's own woff2 files from
  `@fontsource-variable` in `packages/web`, with their SIL Open Font License
  files.
- Pictures: `docs/img/` (from `scripts/screenshots.mjs`) made into WebP by
  playwright-core's own Chromium, offline. A missing picture stops the build.
- Brand: `docs/brand/logo.svg` and `logo-dark.svg` (the header mark and the
  favicon) and `social-preview.png`.
- Copy: the Quickstart block from the README, the copyright line from
  LICENSE, the version from `package.json` and the extension's
  `manifest.json`. Links into the docs point at GitHub and are checked
  against the files and their headings.

## Rules for the copy

Every screen on the site is synthetic example data, labelled as such. Say
"source-available (fair source)". No em or en dashes, no hype words, no
figures the repository does not state. The test checks these, and that every
width from 320 px to 1440 px fits in both themes, with every chip inside the
window and its panel.

The build keeps short things whole: a separator `·` is glued to the word
before it, so a wrapped line never starts with one, and a link's last word
stays with its arrow. Write `5-hour` and `--flags` in running text inside
`<span class="nw">`.
