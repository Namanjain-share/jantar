# Provenance

One row per file that contains code adapted from another project. Add the
row in the same commit as the code, and start the file with:

```
// Portions adapted from <project> (c) <holder>, MIT. See THIRD_PARTY_NOTICES.md
```

Files from Noblot, the maintainer's own earlier project, name its author
(the licensor in `LICENSE`) and no license in the header, which carries the
secret scan's allow marker for that name: they come under this repository's
`LICENSE`.

```
// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
```

`pnpm lint:provenance` fails when a file has that header but no row here, or
when its project is missing from `THIRD_PARTY_NOTICES.md`.

Only MIT projects listed in `THIRD_PARTY_NOTICES.md`, and Noblot (relicensed
by its author under this repository's `LICENSE`), may appear in this table.
GPL, AGPL and closed-source projects are ideas only and never appear here.

## Adapted files

| Our file | Upstream project | Upstream file | Upstream commit | License | Our changes |
|---|---|---|---|---|---|
| `packages/daemon/src/terminal/foreground.ts` | Shed | `server/terminal.js` (`agentInForeground`) | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | TypeScript; checks the session's own pid; claude / shell / other / gone states |
| `packages/daemon/src/terminal/menu.ts` | Shed | `server/menu.js` (`parseMenu`, `keysToChoose`) | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | TypeScript port |
| `packages/daemon/src/terminal/terminal-app/script.ts` | Shed | `server/terminal.js` (`findTab` AppleScript handler, osascript argv pattern) | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | one fixed script with modes; windows walked by id; reads `contents` only; never launches Terminal |
| `packages/daemon/src/terminal/terminal-app/shot-script.ts` | Shed | `server/terminal.js` (`findTab` AppleScript handler, osascript argv pattern) | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | its own constant script with shotinfo / select / restore modes; tab lookup copied from script.ts; windows walked by id; never activates Terminal, raises or de-miniaturizes a window |
| `packages/daemon/src/terminal/terminal-app/open-script.ts` | Shed | `server/terminal.js` (`openTerminalAsync`: `do script` with the command from argv, `tty of` the new tab) | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | a constant script on stdin; the new window found by its tty, walking windows by id (as script.ts does); the window that was in front put back; never activates Terminal |
| `packages/daemon/src/launcher/command.ts` | Shed | `server/terminal.js` (`shellQuote`, the `cd <dir> && <argv>` line of `openTerminal`) | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | plain words left unquoted (shlex.quote's rule); `cd --`; the whole line refused on a control character; cs-shell and cswap-run forms; flags only from `launchFlagArgs`; no prompt file (the first prompt is sent with proof once the session is ready) |
| `packages/daemon/src/terminal/terminal-app/backend.ts` | Shed | `server/terminal.js` (`osascript`, `typeIntoTerminal`) | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | async through the injected exec; safe error mapping; auto / plain / paste typing; CR for Enter; Ctrl-U |
| `packages/daemon/src/writer/proof.ts` | Shed | `server/sessions.js` (`contentText`, `claudeTerminalProgress`) | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | exact squashed match instead of an 80-character prefix; queued, enqueue and slash-command forms; merged flag |
| `packages/web/src/lib/markdown.tsx` | Shed | `public/markdown.js` | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | renders React elements instead of an HTML string; merges consecutive quote lines; keeps an ordered list's start number; task boxes; trims trailing punctuation from bare URLs |
| `packages/web/sw/sw.js` | Shed | `public/sw.js` | `44fc121a1266b6453ace3441ffc6f529d1c54648` | MIT | app-shell precache and offline / route fallback; same-origin check on notification links; sticky "needs you" notifications; re-subscribes when the browser rotates a push subscription |
| `packages/life-core/src/adherence.ts` | Noblot | `packages/core/src/adherence.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header only |
| `packages/life-core/src/meds.ts` | Noblot | `packages/core/src/meds.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; `./adherence.ts` imported as `./adherence.js` |
| `packages/life-core/src/recurrence.ts` | Noblot | `packages/core/src/recurrence.ts`, `packages/core/src/habits.ts` (`HabitScheduleLike`, `isHabitDay`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; `isHabitDay` inlined from `habits.ts` (it uses this file's own `daysInMonth`); `.js` imports |
| `packages/life-core/src/recurrence-rule.ts` | Noblot | `packages/core/src/schemas/recurrence.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the zod schema rewritten as a plain `RecurrenceRule` interface with the same fields (`interval` optional) |
| `packages/life-core/test/adherence.test.ts` | Noblot | `packages/core/src/adherence.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; the import path |
| `packages/life-core/test/meds.test.ts` | Noblot | `packages/core/src/meds.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; the import paths |
| `packages/life-core/test/recurrence.test.ts` | Noblot | `packages/core/src/recurrence.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; the import paths |
| `packages/life-core/src/delivery.ts` | Noblot | `packages/core/src/notifications.ts` (`NOTIFICATION_TIERS`, `quietWindowFor`, `resolveNotification`), `packages/core/src/dynamics.ts` (`inQuietHours`), `packages/core/src/coupleEveryday.ts` (`resolveUsPing`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.11 People: one `resolveDelivery(tier, recipient)` returning push, hold, drop or save; `inQuietHours` as it was; tiers critical, urgent, important, standard (no `off`, no categories or channels: Web Push is the only channel); need space before quiet hours as in `resolveUsPing`; pause, mute, focus, an open night and the recipient's caps added; quiet windows with weekdays |
| `packages/life-core/src/day-review.ts` | Noblot | `packages/core/src/dayPlan.ts` (`DayPlanPick`, `DayPickOutcome`, `resolvePick`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.11 People: `resolvePick` on this package's `dayKeyOf` instead of @date-fns/tz directly; Jantar's `reviewOutcome` with `skipped` and `excused` added, `reviewCounts` and `countsLine` |
| `packages/life-core/src/journal-streak.ts` | Noblot | `packages/core/src/journal.ts` (`dayKeyNumber`, `dayKeyFromNumber`, `addDaysToKey`, `promptForDay`, `journalStreak`, `nextStreakMilestone`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.11 People: milestones 7, 30, 100 and 365 (no 1000); one small neutral prompt pack written for Jantar (none of Noblot's packs) |
| `packages/life-core/test/delivery.test.ts` | Noblot | `packages/core/src/notifications.test.ts` ("the four tiers behave differently"), the `inQuietHours` cases | `c84299e` | relicensed by its author under this repository's `LICENSE` | the tier cases rewritten for `resolveDelivery`'s shape (no categories or channels); the spec 6.3 table row by row added (M22) |
| `packages/life-core/test/day-review.test.ts` | Noblot | `packages/core/src/dayPlan.test.ts` (`resolvePick`, `dayPlanKey`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; the zone case moved onto `resolvePick`; the outcome table and counts added |
| `packages/life-core/test/journal-streak.test.ts` | Noblot | `packages/core/src/journal.test.ts` (prompt packs, day-key math, `journalStreak`, the grace day) | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; the prompt cases on Jantar's pack and a small weekly pack |
| `packages/life-core/src/med-escalation.ts` | Noblot | `packages/core/src/health-report.ts` (`MedDay`, `MedEscalation`, `computeMedEscalation`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.11 People: the rule as it was; the words say "not logged" instead of "missed" and name no medicine; `MED_ESCALATE_DAYS` (2) named |
| `packages/life-core/test/med-escalation.test.ts` | Noblot | `packages/core/src/health-report.test.ts` (`computeMedEscalation`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; Jantar's wording and an unsorted window added |

## Reference commits

The upstream commits reviewed while designing Jantar (see
`THIRD_PARTY_NOTICES.md`). When you copy from a newer commit, record that
commit in your row instead.

| Project | Commit |
|---|---|
| Shed | `44fc121a1266b6453ace3441ffc6f529d1c54648` (v0.2.0) |
| Happy | `2cab104da57898360eea11cee423b6a57d9e50d7` |
| Orca | `abbea996d0a425101f0c7300f1b600000da19ed7` |
| CC Pocket | `0ee5387b1b62f5f64092181d2701d56cc6844037` |
| claude-control | `58ee685f2842c4eff8b3fae52f0a4b4efd0c72ba` |
| claude-code-monitor | `74d82696d56f463031a96951fffb0890a2597331` |
| Noblot | `c84299e` (copied in v0.4) |

## Clean-room specs

| Spec | Covers | Written from |
|---|---|---|
| `docs/hook-protocol.md` | Claude Code hook events, payloads, decision output; the jantar-hook wire format; card lifecycle | Claude Code's hook interface and our own design notes, in our own words |
