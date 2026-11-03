# Accountability partner

Accountability partner (called People in earlier notes, in the code and in
the `jantar people` command) lets you share a space on your Jantar with one
other person who wants a hand keeping to their days: a partner, a family
member, a flatmate, someone you help with their medicines. You act as their
accountability partner. They get their own small app, "Accountability
partner" ("Partner" under its icon), on their own address. You can plan
their day, add to-dos and reminders for them, and see what they agreed to
share. They read exactly what that means before they join, can switch any
of it off later, and can pause, leave or download their data at any time.

It is **off** by default. With it off, nothing about Jantar changes for
you.

> This page describes what is built in this version: their space, to-dos
> you assign, their medicines, day plans, the evening review, alerts, sleep,
> the journal, their assistant and the cafés and lists you share. Someone
> who joined before an area existed gets it only by a request they accept.
> A food log for them is not part of this release: no offer, join page,
> screen or route has one, and `jantar people modules --food` changes
> nothing they can see yet.

## Who is who

- **You (the owner)** run Jantar on your Mac. Your devices, the `jantar`
  command and everything you had before stay exactly as they were.
- **The person you share with** (the code calls them the partner, whoever
  they are) has their own devices, their own cookie, their own address, their own
  event stream and their own push list. Their app reaches their own space
  and nothing else of yours: no sessions, accounts, files, Intel, meetings,
  chat, finance or your own Life data.
- You read their space only through your Accountability partner screens
  (`/v1/people/<id>/…`), each area only while their agreement says so.

## Setting it up

It needs your Mac reachable over HTTPS (`remote.mode` `cloudflare` or
`tailscale`) and a **second hostname** for them, for example
`us.example.com` next to your `jantar.example.com`.

1. Route the second hostname to your Mac and put its own Cloudflare Access
   application in front of it, with a policy that lets in only their email:
   [Their hostname](#their-hostname) below has every step (or see
   [Tailscale](#tailscale)).
2. On the Mac:

   ```sh
   jantar remote people-url https://us.example.com
   jantar people on --name Sam
   jantar people add Asha --email asha@example.com --no-food
   jantar people offer Asha --preset standard
   jantar people invite Asha
   ```

   `people on --name` sets the name their page and app show for you
   (`people invite` refuses until it is set). `people add` prints the
   Access step to do in Cloudflare (Jantar holds no Cloudflare token).
   `people invite` prints a link that works once, for 24 hours: send it to
   them. Until they join, your Accountability partner screen shows them as
   invited, with the link's expiry and Copy link again.
3. They open the link, pass Access, read the join page and accept. Then,
   like your own pairing, their phone walks them through Add to Home Screen
   (on iPhone, where notifications only reach the Home Screen app) and Turn
   on notifications with a test, and their Today keeps a card until
   notifications are on.

"Copy link again" for an invite that hasn't been used needs an admin device
with its device secret (other devices don't show the button; `jantar people
invite` at the Mac makes a new link), and each use is in your audit log
(never the link itself). While the space is switched off, no invite or device-link code works.

Their address is a different origin from yours, on purpose: a page on it can
never write to your routes or open your event stream, and your cookie is
never read there. On their hostname only their routes, `/healthz` and their
app's files answer; everything else is 404. On your hostnames their routes
don't exist.

`jantar people doctor` checks each of these pieces: the settings, your
name, the switch, Life data, their app's build and Web Push, then the host
fence on this Mac (through their hostname jantard serves their app and none
of yours, and through yours none of theirs), and in Cloudflare mode that
Access is in front of their hostname (a visitor without a sign-in is sent
to `*.cloudflareaccess.com`, never answered). Anything to fix is a `FIX`
line with what to do.

## Their hostname

Their app lives on a hostname of its own. In Cloudflare mode (named tunnel,
as in [install.md](install.md#cloudflare-tunnel-with-access) for yours), with `jantar` your
tunnel's name and `us.example.com` theirs:

1. **DNS.** Route the hostname to the same tunnel:

   ```sh
   cloudflared tunnel route dns jantar us.example.com
   ```

2. **Ingress.** In the tunnel's `config.yml` (`~/.cloudflared/config.yml`,
   or the copy the service runs with), add a rule for it before the
   catch-all, pointing at the same local port as yours:

   ```yaml
   ingress:
     - hostname: jantar.example.com
       service: http://127.0.0.1:7420
     - hostname: us.example.com
       service: http://127.0.0.1:7420
     - service: http_status:404
   ```

   Check it with `cloudflared tunnel ingress validate`, then restart the
   tunnel: stop and start `cloudflared tunnel run jantar`, or, for the
   service, `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`.

3. **Access.** In Cloudflare Zero Trust, Access › Applications › Add an
   application › Self-hosted:
   - Name: **Accountability partner**; Application domain:
     `us.example.com`.
   - Session duration: the longest offered (a month), so their Home Screen
     app doesn't ask for a code every day.
   - Login method: **One-time PIN** (a code by email), unless they have an
     identity provider you already use.
   - Policy: name it **Partner**, action Allow, Include › Emails: their
     address only. Keep your own Access application for your hostname as it
     is: theirs never lets you in, and yours never lets them in.

4. **On the Mac:** `jantar remote people-url https://us.example.com`, then
   `jantar people doctor`. "Access in front" must be `ok` before you send
   an invite.

Removing them later: take their email out of the **Partner** policy too
(`jantar people remove` prints the step), and optionally revoke their
session under My Team › Users.

### Tailscale

Sharing your Mac with them over Tailscale works too, but exposes every port
your tailnet policy allows a shared-in user. Serve their hostname on its own
port (for example 8443), share the Mac with their tailnet account, and add
a policy rule that limits `autogroup:shared` to that port only. `jantar
people doctor` reminds you of this step: Jantar can't check your tailnet
policy.

## The offer and the agreement

An invite carries an **offer**: a list of fields saying what you would see
and do. A preset fills it, and flags change single fields after it
(`--see`, `--assign`, `--edit-hers` and `--comment`, each a comma list; `x=off`
turns one off):

```sh
jantar people offer Asha --preset everything --see food=off
jantar people offer Asha --preset light --see sleep,review=full --comment journal
```

| Field | Flag | Light | Standard (default) | Everything |
| --- | --- | --- | --- | --- |
| see their to-dos and reminders | `--see todos` | on | on | on |
| see their day plan, check-ins and status | `--see plan` | on | on | on |
| see their evening review | `--see review=counts\|full` | counts | counts | full |
| see their medicines | `--see meds=adherence\|full` | off | full | full |
| see their weight | `--see weight` | off | on | on |
| see their sleep | `--see sleep` | off | off | on |
| read their journal | `--see journal` | off | off | on |
| read their chats with their assistant | `--see chat` | off | off | on |
| add to-dos and reminders for them | `--assign todos` | on | on | on |
| plan their day | `--assign plan` | on | on | on |
| add medicines for them | `--assign meds` | off | on | on |
| edit or remove to-dos they added | `--edit-hers todos` | off | off | on |
| edit or remove plan steps they added | `--edit-hers plan` | off | off | on |
| edit or stop medicines they added | `--edit-hers meds` | off | off | on |
| correct or remove a weight they logged | `--edit-hers weight` | off | off | on |
| comment on their journal | `--comment journal` | off | off | on |

"Everything" is the name of a preset only: it is everything this version
offers except a food log and your own assistant reading their space, which
no preset has. The join page never uses the word.

The preset is only a template: what is stored, shown on the join page and on
their Sharing page is always the list of fields. Medicines have two levels:
**full** (names, doses, times, whether each dose was taken or skipped, and
the 30-day percentage; never when a dose was logged nor the pill count; the
notes only on medicines you may change, and the join page says which) and
**only how often** (a percentage, no names). `--see food=off` is accepted
and asks for nothing: food isn't in this release.

The join page lists every field on its own line, in plain words, with a
switch that can only turn it down. Whatever they switch off before joining
is what you get.

After they join:

- **They narrow** at any time under Me › Sharing. It applies before your
  next look, and your screens refresh.
- **You ask for more** from an admin device: your Accountability partner
  screen's Sharing tab, or `jantar people ask Asha --see sleep --note "For
  the bedtime plan"` at the Mac. A phone paired the default way (without
  admin) lists what you could ask and shows that command for what you tick
  instead of an Ask button. They see a card with each field that would
  change and answer Allow or No thanks. One request waits at a
  time; after a No, the same field can't be asked again for 7 days, and
  "Don't ask me about this again" blocks it until they clear it. While they
  are paused you can't ask; while their quiet hours or a mute hold your
  alerts, the notification of your request waits too.
- Every step (offered, joined, narrowed, asked, accepted, declined, paused,
  left) is a row in a ledger on your Mac that is only ever appended to.

## Their space

Their to-dos, reminders, projects and weights live in their own space in
your Mac's Life data. Each row remembers who added it.

- **Items you add** show "From Sam" and apply at once, with a due day and
  time, a repeat (every day, week or month: one item that comes back after
  each Done), "no snooze" or a "Got it" if you like. They can tick it, undo,
  snooze (unless you said no snooze), skip it with a reason, say Got it, or
  **Ask to change** (you see their note on the item). You see a skip's
  reason too, and their join page and Skip sheet say so; their Undo (a
  repeating item's included) puts the date back and takes the reason
  back. They can't edit or delete your items.
- **Items they add** are theirs to change: a tap on a to-do opens its
  sheet (snooze, skip, edit, delete), and a day and time on one makes it a
  reminder that rings their phone. With "edit or remove to-dos they
  added" on, you can change or remove them too: each shows "Edited by Sam",
  and their Activity keeps the old and new value of every field you changed.
- **Medicines**: theirs, in their own space, apart from yours. They add,
  edit and stop any of them (yours for them included), and tick each dose
  Taken or Skip on Today or Health › Medicines, with Undo. With "add
  medicines for them" on, you can add one: it shows "added by Sam", and
  you edit or stop your own additions. With "edit or stop medicines they
  added" on, you can change or stop theirs too: each shows "Edited by Sam",
  their Activity keeps the old and new value (the name, dose, times, days
  or pill count), and their phone moves its reminder at once. When they
  change one you added, you are told. Nobody deletes a medicine of theirs
  from your side, and only they log doses.
- **Weight**: they log it, for today or an earlier day, and delete a day
  (with Undo). With "correct or remove a weight they logged" on, you can
  correct or remove a day they logged (Health › Correct), never add one;
  their day then reads "Corrected by Sam (was 72.4 kg)" until they log it
  again, and their Activity keeps both values.
- **Never in their name.** No screen, route or command of yours ticks their
  items done, snoozes or skips them, logs or undoes a dose, logs a weight
  for them, or pauses, resumes or narrows for them.
- **Their reminders and doses ring their devices**, not yours, and open
  their app. Their 08:00 dose and yours are two separate notifications.
  While the space is off nothing of theirs rings; when it is back on, a
  reminder missed in the last 6 hours rings once, marked late.

## Your Accountability partner screen

On your phone or browser, **Accountability partner** is in More (and on the
rail on a wide screen; "Partner" if it is a phone tab) while the space is
on, on a device paired with control. `/people` opens the person you share
with; while they are only invited, or their sharing is ending, it is a
list that says so. It is loaded
only when you open it. Your Today shows one line for them ("Asha · 3 of 7
done · Now: Interview prep 11:00 · Low", or "Asleep since 23:40", and "1
dose not logged" when you see their medicines), and every notification
about them opens the right tab here.

- **Header**: their status and line, "Asleep since" while a night is open,
  the day's progress and the Now step, a line when an alert from them is
  new, and three buttons: **Plan** (today before 18:00, tomorrow after),
  **Assign** (a to-do: title, due day and time, a repeat, what it asks of
  them (nothing, Got it, or a short report), no snooze, and "Tell me if not
  done by") and **Alert**.
- **Today**: their plan as they see it, with each step's status, done time,
  report and check-in answers, a "late" label, Nudge on an open step, the
  check-betweens, and from their review time the evening review at the
  level they share (with "Carry your open steps to tomorrow").
- **To-do**: their items and yours for them, open first, with Nudge on an
  open one, and Edit and Delete on yours (and on theirs with "edit or
  remove to-dos they added" on).
- **Plan**: the editor. Start from the weekday's template, Copy yesterday,
  Copy last {weekday}, any template, or **Quick plan**: type "Mock at 8,
  then analysis 45m !report, every 2h 10-18 check applications" and the
  steps appear as you type (no AI, nothing leaves your Mac; anything it
  can't read becomes a plain step). Reorder with Move up and Move down; a
  quiet hint says when times run out of order. Save as template, and Send
  (in a bar at the bottom on a phone). Send says what happened: "Sent." when
  it goes now, or "Saved. Asha gets it Wed 4 Nov at 07:00" when it waits
  for their plan time. Every save is a look at their plan too, so it leaves
  a view mark in their Activity, and your changes to your own steps are
  listed there ("Sam changed the time of 'Mock' 08:00 → 08:30").
- **Health**: their medicines at the level they share. At **full**, each
  medicine ("added by you", or theirs, "edited by you"; its notes when you
  may change it), the day's doses (Taken, Skipped, Not logged, never the
  time they logged it) and Add a medicine for them, Edit and
  Stop where the agreement allows; at **only how often**, a percentage and
  how many of today's doses aren't logged, with no names. On both, when
  doses went unlogged two days running, one plain line: "Doses not logged 2
  days running. Worth checking in." It is worked out when you look, never
  stored, and they see the same line on their side. Then their weights
  (Correct on each day with "correct or remove a weight they logged") and
  their sleep week.
- **Journal** (read, and comment if they allow it) and **Alerts** (both
  ways, with replies).
- **Sharing**: what they agreed to, in the words their page used; **Ask for
  more** (one request at a time; "Waiting for Asha's answer" while it is
  open); their devices with the email each joined with; and your pushes
  about them: the day summary (off until you pick a time), "Asha sent the
  evening review", and quiet hours (`jantar people prefs` sets the same).
- **Activity**: their record, the same rows they read, in your words ("You
  looked at Asha's Today 2 times").
- An area they keep private is a grey tile: "Asha keeps this private".

## Their day plan

With "plan your day" on, you can give them a plan for a day: steps in
order, each with an optional time, length, notes and an ask (none, "Got
it", a short report, or a check-in of mood and energy). A plan can also
hold up to four **check-betweens** ("Check applications every 2 h,
10:00–18:00"): each slot is a circle they tick from its time until the
next slot.

- **Sending.** A plan for today, saved after their plan push time, goes
  out at once ("Your plan for today: 7 steps"); a plan for another day goes
  out at their plan push time (07:00 unless they change it). If the first
  step rings within 15 minutes, that ring carries the plan instead. Your
  later changes to a sent plan reach them once per 2 minutes ("Sam changed
  today's plan: 2 steps moved, 1 added") and ask for Got it again.
- **Templates.** Save a day as a template, with weekdays if you like. At
  00:05 on a matching weekday, a day with no plan gets the template.
- **Their side.** Today shows Now, Next and Later, with a tick circle on
  every row and a bar at the bottom: Got it, then Done: {the Now step}.
  Every tick has a 5-second Undo. They can skip with a reason, ask you to
  change a step, add steps of their own, switch ringing off for any step,
  and mark any step as focus. A step still open 15 minutes after its time
  shows "late"; nothing is scored or sent.
- **Their steps** come through your edits unchanged unless "change plan
  steps they added" is on; then each change says "Edited by Sam" and their
  Activity keeps the old and new values.
- **Focus.** While a focus step is running (its length plus 30 minutes, or
  90 minutes), your gentle and normal alerts and nudges wait, and their own
  rings stay quiet. Urgent follows their quiet-hours setting.
- **Follow-ups.** On a step or to-do you gave them, "Tell me if not done by
  13:00" pushes you once at that time if it is still open, after checking
  again that they still share that area. It is never sent to them; their
  item says "Sam asked to know by 13:00". A to-do that asks for a short
  report says so on their row, and their tick opens the report sheet (Save
  note, or Done without a note), as a plan step's does.
- **Rough day.** One tap clears the rest of their day (each open step reads
  "rough day"), stops today's rings and sets their status to Low. You get
  one line, "Asha marked today a rough day", 10 seconds later, so a stray
  tap can be undone first. You can plan tomorrow, not the rest of today.
- **Status.** Okay, Low or Need space, with a short line; it clears after
  12 hours. Need space holds your alerts except Urgent. Only they set it.

**Rings** have tiers, decided by one resolver, the same one your alerts
and comments go through. Their medicine doses and own reminders always
ring. Step and check-between rings and the evening review prompt are
dropped (never rung late) during their quiet hours, focus, an open night, a
mute or a pause. The plan push waits for those to end; a to-do you gave
them with a time doesn't ring then, and neither does the notification of a
change of yours (an item, a medicine, a corrected weight, a deleted list,
a request for more): each is counted in the one line they get when the
hold ends ("A reminder and 2 updates from Sam while you were in quiet
hours"). Rings due in the same minute are one notification.

## The evening review

From their review time (21:00 unless they change it), Today shows "How did
today go?". It lists every step as it was sent (one you removed reads
"gone"), each check-between ("3 of 5"), and their to-dos due that day, each
done, skipped, moved, missed or open. They can carry their own open steps
to tomorrow, ask you to carry yours (one request on the Alerts page), add a
note and a mood, and also save it to their journal. They send it once; if
they don't, it closes itself at noon the next day with no note, and nothing
is pushed or counted. "Moved" and "missed" are grey, never red, and nothing
here becomes a score, a streak loss or an alert.

You see it at their sharing level: **counts** ("5 done · 1 moved · 1
missed") or **full** (each item, the note and the mood), and you can carry
your open steps from it. You get one push when they send it, with no note
text.

## Alerts, both ways

Both of you have an Alerts page: Check in, Call me, Urgent, Good morning,
Good night, Thinking of you, Running late (theirs), a reminder about an
item (yours), Ask to change (theirs) and a custom line. Replies are one
tap ("Can't right now, I'm safe" is a normal answer) and close after 24
hours. "Seen" means they opened it, never just that it arrived. Alerts are
kept 90 days.

- **Limits belong to whoever receives.** By default: 6 alerts an hour and
  20 a day, 4 Urgent a day (never more than 2 an hour), one reminder per
  item an hour and 8 a day. Each person sets their own within fixed ranges;
  over a limit an alert is saved without a notification.
- **Held, not lost.** Their pause (Urgent included), mute, Need space, a
  focus step, sleep (if they hold alerts while they sleep) and quiet hours
  hold your alerts; when that ends they get one line ("2 alerts and a
  comment from Sam while you were in quiet hours"). Urgent goes through
  quiet hours unless they switch that off. Your send sheet says why it
  would wait; "asleep" shows only if they share sleep, otherwise "quiet
  time".
- **Lock screen.** Their choice: show everything, hide alert text (the
  default: "Alert from Sam"), or hide everything.
- Every Accountability partner notification is a Web Push to that person's own devices,
  never a Mac banner or Telegram. One sent to you about them is checked
  against what they share at the moment it is sent.
- **A day summary** for you is opt-in (one line at a time you pick, counts
  only: "Asha's day: 5 of 7 done · review sent · 1 dose not logged", never
  a medicine's name); their Sharing page lists it while it is on.

## Sleep

They can log nights: bedtime, wake time, how they slept (five faces) and a
note, by hand under Health › Sleep or with **Going to sleep** (Today, from
20:00) and **Woke up**. A night belongs to the evening it started (a
bedtime before noon counts for the day before). If they never tap Woke up,
the night says "no wake time yet" and closes after 20 hours as "wake time
not logged": no time is guessed. The week view shows each night as a bar,
the average, bedtimes and a trend arrow only when both weeks have four
nights. Under 6 hours reads "short", in plain text.

"Hold alerts while I sleep" (on by default) holds your alerts while a night
is open (at most 14 hours), as quiet hours would, and releases them when
they tap Woke up. With "their sleep" on, you see the same week and "Asleep
since 23:40"; you never get a notification when they go to sleep or wake,
and you can't add or change a night.

## Journal

Their journal is a dated list of entries and one-tap check-ins (a mood and
up to three of Joyful, Strong, Close, Anxious, Sad, Angry and Flat). Only
they write, edit or delete it. With "their journal" on, you can read it;
with "comment on their journal" on, you can comment under an entry, and
they can reply. Each of you deletes only your own comments. A comment
pushes the other once ("Sam commented on your journal"), with no text,
held like an alert and counted against their limits. The streak counts days
with anything written; milestones show once, in the app only, with no
"streak at risk" and no penalty, and "Hide my streak" hides it on both
sides. Journal text never appears in a notification, the audit log, logs,
Activity, the `jantar` command's output or either assistant.

**The 14-day check-in.** Every 14 days their Today asks "Is this setup
still working for you?": Keep going, Ease off a bit, Pause, or Let's talk
(you get a neutral alert). The answer is theirs alone unless they pick
Let's talk or tick "Tell Sam my answer"; skipping it counts for nothing.

**Never from these.** Moods, check-ins, nights, journal entries and review
outcomes never create an item, an alert, a score or a concern line.

## Shared lists: cafés and lists

Some lists are both of yours, not one person's: they live in a space you
share (one per person, made when you add them), so there is nothing to
switch on or off in the agreement.

- **Cafés.** Your Cafés list shows your own and the shared ones (a
  "shared" tag on each); their app's Lists › Cafés shows only the shared
  ones. Either of you adds, rates, notes and changes dishes; the last edit
  wins and shows "Edited by Asha · 2 Nov". Each of you logs your own visits
  ("You" or the other's name) and changes or deletes only your own. Cafés
  they add are always shared. On your Accountability partner screen's Lists tab you share a
  café of yours (one, or Share all) and move one you added back to just
  you; one they added stays shared.
- **Lists** (shopping, to watch, to read, plain): either of you adds,
  edits, ticks, unticks and deletes items and renames lists; a tick shows
  "Ticked by Asha · 18:20". Items have no due day and never ring anyone.
  **Assign to Asha** (yours, with "add to-dos for them" on) makes an
  ordinary to-do of theirs from the item's title ("From Sam"), and marks
  the item "Assigned to Asha"; the two aren't linked.
- **Deleting** a café or a list is a Confirm for either of you ("Delete Blue
  Door for both of you?"), and the other gets one notification and a line in
  their Activity.
- **Assistants.** Their assistant reads and changes the shared cafés and
  lists (never yours alone). In either assistant, text the other person
  wrote or last edited is framed as data, and the assistant's writes then
  wait for a tap.
- **When they're forgotten** (after leaving, or removed with forget), the
  shared cafés and lists stay, as yours, with their authorship gone.

## Their assistant (Chat)

Their app has its own Chat: an assistant for their day, in a thread of
their own. It runs on your Mac, with your Claude accounts, through the same
picker and one-run-at-a-time queue as yours, so every rule you set for which
accounts Jantar may use applies to their runs too.

- **What it can do.** It reads their plan, to-dos, weight and sleep, and
  only theirs: it adds and changes their own to-dos and projects, starts,
  finishes, skips and adds plan steps, ticks check-betweens, answers
  check-ins, sets their status and logs a night, each with Undo. A delete
  is a card they tap, and so is an alert to you ("Send Sam 'Running
  late'?"). Items and steps you added are theirs to do, never to change:
  it can tick or skip them, not edit or delete them.
- **What it can't.** It has no journal tool (their journal stays out of
  every assistant, theirs included), and nothing of yours: no sessions,
  accounts, Intel, meetings, money, posts, and no way to assign anything to
  anyone. Its tools are a fixed list; even a tool listed by mistake reaches
  only their space.
- **Your words are data.** Anything you wrote or last edited (an item's
  title and notes, a plan step, the plan's note) reaches their assistant
  inside `<data source="owner">`, and after reading it the assistant's
  writes become cards they tap. A line in a step can't make it act.
- **Their limits.** 30 messages a day by default ("12 messages left
  today"); you change the number on their Chat tab, and it shows in their
  Activity. At most 2 messages wait at once. Their thread is kept 1, 7 or
  30 days, as they choose (your own keep never applies to it). Refusals use
  a fixed set of words ("The assistant is busy. Try again in a few
  minutes.", "Today's messages are used up.") that never name an account,
  an email, a limit or a reset time.
- **Who can read it.** With "Your chats with your assistant" on, you can
  read their thread on your Accountability partner screen (Chat tab): their messages, the
  answers, photos they send and what it changed, read only, with no box to
  type in and no Undo. Each look is in their Activity ("Sam read your
  chat", once an hour). While it's on, their Chat says "Sam can read this
  chat" above the box on every visit. With it off, you can't open it, your
  devices don't refresh when they chat, and you see only how many messages
  they send a day (the audit log's `chat.run` rows, with no text). The
  disclosure is on the join page, behind ⓘ in their Chat, and is the first
  message of a new thread.
- **Photos** they send are stripped of location, camera details and embedded
  thumbnails before they're kept.
- **Delete and Clear** are theirs: a message they delete, or a thread they
  clear, is gone for both of you. Their thread is in their download, and
  forgotten with their space.
- **Not in this version:** your own assistant reading their space (the
  `assistant` field). It isn't offered, in any preset or request.

## What each side sees

- Your Accountability partner screens show each area they share. An area they keep private
  is a grey tile: "Asha keeps this private". It is never just missing, and
  never counts how long it has been off.
- **See what Sam sees**: under Me › Sharing they can open exactly the view
  you get of each area, drawn with the same pieces your screen uses. Both
  come from one function, so they can't differ.
- **Activity** (theirs, and readable by you too on your Activity tab) lists
  every change you make in their space, each request and answer, devices
  linked or revoked, each device of yours that can newly open their space
  (paired with control, or raised to it), and every time you look at an
  area (one line per area per hour), in plain words under a header for each
  day. Their join page and Sharing say that you read it, with the names of
  their devices and when they link one, pause, resume or change what they
  share, and that those times and the ones on what they share are the only
  times you see.
- **The evening review** holds their to-dos only while they share their
  to-dos: switched off, the to-dos are out of what you see of the review
  and of its counts, sent reviews included.
- **A held alert** names why it is held (asleep, asked for space, focusing)
  only while you see the area behind it; otherwise it says "quiet time".
- Your stream refreshes for their changes only in areas you can see, and
  theirs never tells them when you are busy elsewhere.

Never collected or shown: their location, their IP address, when they last
opened the app, typing, screen time, a "last seen". Their own writes reach
your audit log as `person.write` with no detail.

## Pause, leave, remove

- **Pause** (theirs alone): your new items and changes wait (you see "Asha
  has paused"); you can still read what they share. Only they can resume.
- **Leave** (theirs alone): download first, then keep their data 30 days
  (they can come back on a new invite meanwhile) or delete it now, and type
  LEAVE. Their devices are revoked at once.
- **Remove** (the Mac only): `jantar people remove Asha` gives them 7 days to
  download their data; `--now` ends it at once; `--forget` deletes their
  space at once. Remove their email from the Access policy once sharing has
  ended: the command prints the step, and with the 7 days it names the day.
  Not before, or Access shuts them out of the download their page promises.
- **After it ends**, your People list keeps a row for them while their data
  is kept (30 days), with the way to invite them again or to delete it now
  (`jantar people remove <id> --forget`).
- **Off** (`jantar people off`): your Accountability partner screens
  disappear, and they can still download their data or leave.

Pause, Leave and Download keep working when the space is off, when the daemon
runs read-only, and (Leave and Pause) when Life data can't be opened.

At the Mac you can revoke one of their devices (a lost phone: `jantar people
devices Asha`, then `jantar people revoke <device-id>`), but not their last
one: ending sharing is `jantar people remove`, which gives them their 7
days.

## Devices and notifications (theirs)

- **Link another device**: Me › Devices makes a code that works once, for 5
  minutes; they enter it on the new device at `/p/link`. Five devices at
  most. Revoking a device also voids any code it made that wasn't used. They see each device's name, when it was last used, and the email it
  joined with; you see names and the email only.
- **Notifications**: turn on and test, mute for an hour or eight, and the
  lock screen: show everything, hide alert text, or hide everything
  ("Accountability partner · Medicine time"). Their mute is theirs; yours never holds their pushes.
  Also theirs: quiet hours, whether Urgent breaks through, their plan push
  and evening review times, holding alerts while they sleep, hiding the
  streak, the limits on your alerts, and ring switches for plan steps,
  check-betweens and plan changes (you see these on Sharing).

## Download

Me › Leave (and the ending banner) downloads everything in their space: a
readable page (no scripts, nothing fetched) or a data file (JSON).

## The honest limits

- Their space is stored on your Mac, in Jantar's nightly backups and in any
  backups of the Mac. As the Mac's owner, you, or a program you run there,
  could open those files directly, whatever they switch off. Jantar's promise
  covers what it shows. The join page says so.
- Reminders ring only while your Mac is on and online. Leaving and
  downloading also need it on.
- Cloudflare carries the connection to your Mac. The email you give `jantar
  people add` is a reminder for the Access step; at join, in Cloudflare mode,
  Jantar compares it with the email Access forwards to catch a mistake (it
  does not verify Access's token).
- A Life restore can't bring back someone who was forgotten: the ledger
  wins. Someone still sharing whose space a restore removed is asked to set
  sharing up again, and you can neither see nor add anything in that space.
  Your Accountability partner screen and `jantar people list` say so (by id and the email
  their phone joined with: the name was in what the restore took out). To
  invite them again: `jantar people add <name> --email <address>`, then
  `jantar people invite <name>`; once they have joined, `jantar people
  remove <id>` clears the note. If a newer backup still has their space,
  restoring that brings sharing back instead.
