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
| `packages/life-core/src/delivery.ts` | Noblot | `packages/core/src/notifications.ts` (`NOTIFICATION_TIERS`, `quietWindowFor`, `resolveNotification`), and from two other files in `packages/core/src/` the quiet-hours check `inQuietHours` and the receiver-side wrapper `resolveUsPing` | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.11 People: one `resolveDelivery(tier, recipient)` returning push, hold, drop or save; `inQuietHours` as it was; tiers critical, urgent, important, standard (no `off`, no categories or channels: Web Push is the only channel); need space before quiet hours as in `resolveUsPing`; pause, mute, focus, an open night and the recipient's caps added; quiet windows with weekdays |
| `packages/life-core/src/day-review.ts` | Noblot | `packages/core/src/dayPlan.ts` (`DayPlanPick`, `DayPickOutcome`, `resolvePick`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.11 People: `resolvePick` on this package's `dayKeyOf` instead of @date-fns/tz directly; Jantar's `reviewOutcome` with `skipped` and `excused` added, `reviewCounts` and `countsLine` |
| `packages/life-core/src/journal-streak.ts` | Noblot | `packages/core/src/journal.ts` (`dayKeyNumber`, `dayKeyFromNumber`, `addDaysToKey`, `promptForDay`, `journalStreak`, `nextStreakMilestone`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.11 People: milestones 7, 30, 100 and 365 (no 1000); one small neutral prompt pack written for Jantar (none of Noblot's packs) |
| `packages/life-core/test/delivery.test.ts` | Noblot | `packages/core/src/notifications.test.ts` ("the four tiers behave differently"), the `inQuietHours` cases | `c84299e` | relicensed by its author under this repository's `LICENSE` | the tier cases rewritten for `resolveDelivery`'s shape (no categories or channels); the spec 6.3 table row by row added (M22) |
| `packages/life-core/test/day-review.test.ts` | Noblot | `packages/core/src/dayPlan.test.ts` (`resolvePick`, `dayPlanKey`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; the zone case moved onto `resolvePick`; the outcome table and counts added |
| `packages/life-core/test/journal-streak.test.ts` | Noblot | `packages/core/src/journal.test.ts` (prompt packs, day-key math, `journalStreak`, the grace day) | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; the prompt cases on Jantar's pack and a small weekly pack |
| `packages/life-core/src/med-escalation.ts` | Noblot | `packages/core/src/health-report.ts` (`MedDay`, `MedEscalation`, `computeMedEscalation`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.11 People: the rule as it was; the words say "not logged" instead of "missed" and name no medicine; `MED_ESCALATE_DAYS` (2) named |
| `packages/life-core/test/med-escalation.test.ts` | Noblot | `packages/core/src/health-report.test.ts` (`computeMedEscalation`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; Jantar's wording and an unsorted window added |
| `packages/life-core/src/work/task-review.ts` | Noblot | `packages/core/src/taskReview.ts` (`completedByProject`, `doneCountsByWeek`, `isStale`, `openTaskHealth`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: the provenance header only; Jantar's project health line (`work/project-health.ts`, ours) builds on it |
| `packages/life-core/test/work/task-review.test.ts` | Noblot | `packages/core/src/taskReview.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; the import path |
| `packages/life-core/src/work/tags.ts` | Noblot | `packages/core/src/tags.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: the provenance header; `TAG_MAX_LENGTH` 30 (Work's tag cap, was 40); comments no longer name Mongo |
| `packages/life-core/src/work/csv.ts` | Noblot | `packages/core/src/csv.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: the provenance header; the BOM written as `\uFEFF` |
| `packages/life-core/src/work/contacts.ts` | Noblot | `packages/core/src/contacts.ts` (normalizers, links, initials avatar, `findDuplicateGroups`, `duplicatePairKey`, `formatCommunication`, the touch rule, vCard) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: typed edges, merge planning, important dates, healthcare and custom fields left out; `id` for `_id`; an `http:` link stored as `https:`; `formatCommunication` as `formatLogLine` on Work's log shape (channels with `note`, `out`/`in`, `minutes`, outcomes good, neutral, bad, no answer); the touch rule as Work's fixed kinds (`countsAsTouch`, `lastTouchAt`) |
| `packages/life-core/test/work/tags.test.ts` | Noblot | `packages/core/src/tags.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; the import path; the length cap 30 |
| `packages/life-core/test/work/csv.test.ts` | Noblot | `packages/core/src/csv.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; the import path; the BOM written as `\uFEFF` |
| `packages/life-core/test/work/contacts.test.ts` | Noblot | `packages/core/src/contacts.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the provenance header; the import path; fixtures on made-up companies; the edge and merge cases left out with their code; Work's cases added (the 10-digit rule against short foreign numbers, `https:` links, the log line's note and outcome, touches, a skipped photo) |
| `packages/life-core/src/work/deal.ts` | Noblot | `packages/core/src/deal.ts` (lost-reason codes and labels, `lossCodeBreakdown`, sources, the expected close) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: the eight codes fixed (no per-workspace additions, so `resolveLostReasons` is left out); `lostCode` for `lostReasonCode`; the close as a Life-zone day key, `daysUntilClose` calendar arithmetic on two keys (never the host's clock); won-revenue reconciliation left out for invoices (a later phase) |
| `packages/life-core/test/work/deal.test.ts` | Noblot | `packages/core/src/deal.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; close days as day keys; the reconciliation cases left out with their code; a month end, a leap day and a DST weekend added |
| `packages/life-core/src/work/pipeline.ts` | Noblot | `packages/core/src/pipeline.ts` (the quiet threshold, `stageInvariantError`, `planStageDeletions`, `stageProbabilities`, `weightedAmount`, `pipelineForecast`, `dealIsClosed`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: "stale lead" is "quiet" (`resolveQuietDays`); a structural stage type; task-reminder defaults, the multi-workspace threshold, checklists, the one-live-deal rule and the lead CSV's deal columns left out |
| `packages/life-core/test/work/pipeline.test.ts` | Noblot | `packages/core/src/pipeline.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; the cases of the parts left out go with them; Work's four default open stages added |
| `packages/life-core/src/work/stage.ts` | Noblot | `packages/core/src/stage.ts` (`resolveStageStaleDays`, `stageHealth`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: quiet days per stage and the column's health; WIP limits and stage automations left out (design non-goals) |
| `packages/life-core/test/work/stage.test.ts` | Noblot | `packages/core/src/stage.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; the WIP and automation cases left out with their code; the threshold edge and an empty column added |
| `packages/life-core/src/work/insights.ts` | Noblot | `packages/core/src/pipelineAnalytics.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: money per currency (`groupByCurrency`, never summed across); the deal sequence and the free-text loss breakdown left out (Work's deals are rows, its losses codes); the financial year (`fy`, from 1 April) added as a period |
| `packages/life-core/test/work/insights.test.ts` | Noblot | `packages/core/src/pipelineAnalytics.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the import path; the sequence and free-text loss cases left out with their code; the financial year and the per-currency split added |
| `packages/life-core/src/work/milestones.ts` | Noblot | `packages/core/src/projectSections.ts` (`sectionProgress`) | `c84299e` | relicensed by its author under this repository's `LICENSE` | v0.13 Work: a milestone is its own step (todos stay flat), so progress counts milestones; its target is a day key; grouping tasks by section left out |
| `packages/life-core/test/work/milestones.test.ts` | Noblot | `packages/core/src/projectSections.test.ts` | `c84299e` | relicensed by its author under this repository's `LICENSE` | the progress case on milestones; the grouping case left out with its code; due today, the next milestone and none added |

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
