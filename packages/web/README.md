# @jantar/web

The dashboard and installable phone app (PWA): Vite, React 19, TypeScript and
zustand, fed by the shared protocol reducer. The display name lives in one
constant, `src/brand.ts` (`PRODUCT_NAME`); the build writes it into
`index.html` and the manifest.

## Look and layout ("B+ Ledger in Kundali colours")

- **Tokens:** `src/styles/tokens.css` is the only file with colour literals and
  font sizes. Day (cream and navy) is the default; night is deep navy.
  Coral/brick red means "needs you" only; mustard marks time and luck only.
- **Styling:** Tailwind CSS v4 (`@tailwindcss/vite`) with the default theme
  wiped (`@theme { --*: initial; }`): only our tokens exist as utilities
  (`bg-surface`, `text-ink-3`, `border-line`, `rounded-btn`, `type-row`,
  `h-48` where 1 unit = 1 px). It compiles to one static CSS file, which the
  strict CSP (`style-src 'self'`) needs.
- **Kit:** `src/ui/kit/` (glyphs, mark, buttons, tags, meter, strip, sheet,
  hold-to-commit, spinner, skeleton, legend). **Shell:** `src/ui/shell/`
  (top bar, rail, status bar, phone header and tabs, Cmd-K, legend).
- **Libraries:** Base UI (unstyled primitives, wrapped in
  `CSPProvider disableStyleElements`), Motion (`LazyMotion` + `m`), Phosphor
  icons, cmdk, Fontsource variable Archivo and JetBrains Mono (self-hosted,
  latin subset).
- `test/design-rules.test.ts` enforces the mechanical anti-slop rules
  (no colour literals outside the tokens, no stock palette, one shadow, no
  runtime `<style>`, ...).

```
pnpm --filter @jantar/web dev        # dev server on 127.0.0.1:5173, proxies /v1 to jantard on :7420
pnpm --filter @jantar/web build      # production build into packages/web/dist (the daemon serves it)
pnpm --filter @jantar/web test       # vitest + Testing Library (jsdom); the API is mocked
pnpm --filter @jantar/web typecheck
```

## Screens

| Path | Screen |
|---|---|
| `/` | **Board**: a display line ("3 need you" with Start, or "All clear"), then the ledger in rails NEEDS YOU (oldest wait first) / YOUR TURN / WORKING / ENDED. Two-line rows: glyph, folder, session name, age; then the question, command, plan line, tool or last reply, with the account and its 5h %. On a desk, the **Desk** beside it: up to three cards to answer, the next three resets as runways, new alerts and the legend |
| `/s/:sid` (`?p=<pendingId>` raises a card) | **Session**: header with steppers (`1 / 3`) and Show on Mac; Transcript or Screen tab; a dock for the open card in Claude's own words (permission: Yes, "Yes, and … for this session" (several suggestions in one row; held 2 s for shell rules and mode switches), No with an optional note "Tell Claude what to do instead", No, and stop Claude; question: options, multi-select, "Type something…", "Chat about this"; plan: "Yes, manually approve edits" or "Yes, auto-accept edits", "Tell Claude what to change…"; the "Yes, and use auto mode" row waits for spike SP8, `HOOK_PLAN_AUTO`); without a card, a waiting session's terminal dialog as buttons (TermDialog) and the keypad; after answering, a receipt with "Next"; otherwise the composer, with delivery stages and "Not delivered" with Retry |
| `/accounts` | **Accounts**: one display line ("1 account runs out before its reset"), the source line (cswap cache age, autoswitch ceiling from `/v1/plan`, `next → 08`), and the matrix: 5h bar with the ceiling tick, runway to the reset with dead time dashed, resets, 7d, burn, the account's sessions and flags. Rows expand into words. Moves lanes below |
| `/alerts` | **Alerts**: "3 new", day rails, rows that expand, Open session / Open accounts, Mute pushes |
| `/devices` | **Devices**: this device (theme, install, notifications and their kinds), paired devices (admin: revoke by holding), pair a device (QR dialog with a countdown) |
| `/pair#c=<code>` | **Pair** a phone or browser, then the Home Screen and notifications steps. The code stays in the fragment, is removed from the address bar at once, and is only sent (in a POST body) after a tap |

Cmd-K jumps to any session or account; `j`/`k`, `↵`, `1`-`9`, `a`, `d`, `r`,
`?` and `g b/a/l/d` work on a desk (direction 5.9). From 1024 px a session
opens beside the ledger; the phone gets a header, the strip and a tab bar.

## How it talks to the daemon

- `src/lib/connection.ts`: `GET /v1/state`, then `WS /v1/events?after=<seq>`.
  On a gap or a new daemon epoch it resyncs from REST. If the socket keeps
  failing it polls `GET /v1/state` every 5 s while retrying the socket with
  backoff. A heartbeat silence of 50 s counts as a dead socket. A 401 shows the
  pairing steps.
- `src/lib/api.ts`: typed client built on the protocol's `ROUTES` table. Every
  write carries an `Idempotency-Key`. Cookies are same-origin only and no
  token ever goes in a URL.
- `src/store.ts`: zustand store wrapping `reduce()` from `@jantar/protocol`.

## What the daemon must provide

1. **SPA fallback.** Answer `GET` for `/`, `/pair`, `/s/*`, `/accounts`,
   `/alerts` and `/devices` (any non-`/v1` path without a file extension that
   accepts `text/html`) with `dist/index.html`. Pairing links
   (`<base>/pair#c=<code>`) depend on it. Once the service worker is installed
   it also serves the cached shell for these paths.
2. **Headers on the HTML.** The built `index.html` already has this CSP in a
   `<meta>` tag. Send the same policy as a header, plus what a meta tag
   cannot carry:
   `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
   `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
3. **Caching.** `/sw.js`, `/index.html` and `/manifest.webmanifest` with
   `Cache-Control: no-cache`; `/assets/*` (content-hashed) may be immutable.
   Serve `.webmanifest` as `application/manifest+json`.
4. **Web Push payload** (JSON, encrypted by web-push). The service worker
   reads:

   ```json
   { "title": "web-app needs you", "body": "Question: Which database?",
     "kind": "question", "tag": "s:<sid>", "url": "/s/<sid>?p=<pendingId>",
     "sid": "<sid>", "pendingId": "<id>", "ts": 1760000000000 }
   ```

   `url` must be a same-origin path (anything else opens `/`). Without `url`,
   `sid` and `pendingId` build the link. `kind` in permission, question, plan
   or send-failed keeps the notification on screen until it is acted on. Every
   push shows a notification (iOS revokes silent ones), so never send a
   "close" push. The app closes a session's notifications itself when the
   session is opened.

## PWA

- `manifest.webmanifest` is generated by `build/pwa-plugin.ts` from
  `src/brand.ts` and the `--bg` tokens (`build/brand.ts`). Icons in
  `public/icons/` and the favicons (`public/favicon.svg`,
  `public/favicon-needs.svg`, swapped while anything needs you) are drawn from
  the brand mark by `node scripts/gen-icons.mjs` (dependency-free, reads
  `tokens.css`, outputs committed).
- `sw/sw.js` is the service-worker template. `build/pwa-plugin.ts` fills in the
  precache list and a version at build time, emits `dist/sw.js`, and adds the
  CSP meta tag. The worker never touches `/v1` or `/healthz` and never caches
  anything cross-origin.
- iPhone and iPad: push only works from the Home Screen app (iOS 16.4+, which
  is also the build target). The Devices screen explains it. There is no
  banner on every screen any more; the install step belongs in the pair flow
  (design direction 5.7).

## Safety notes

- Transcript text (replies, plans, tool input) is untrusted. It is rendered
  by `src/lib/markdown.tsx` as React elements, never as HTML, and only
  http(s) links become clickable. A test fails if `dangerouslySetInnerHTML`,
  `innerHTML` or `insertAdjacentHTML` shows up anywhere in `src/` or `sw/`.
- "Always allow" for a shell rule is a 2-second hold that shows the rule it
  saves, and the app still asks for a second tap when the daemon answers
  `needs_confirm`.
- `test/integration/web.integration.test.ts` loads the built `dist/` in
  headless Chromium under the daemon's real headers and fails on any CSP
  report (Board, Session with the dock open, Cmd-K, the Pair dialog). It also
  holds the density gates and the grayscale check.
- Local storage holds only conveniences (theme, dismissed hints, this
  device's id, name and scopes, its notification kinds, the last alert seen
  and the last state for an instant first paint), never keys. The device
  secret lives in IndexedDB (`src/lib/credential.ts`).

## Provenance

`src/lib/markdown.tsx` and `sw/sw.js` adapt code from Shed (MIT, (c) Sukhad
Anand). See the header in each file and `THIRD_PARTY_NOTICES.md`.
