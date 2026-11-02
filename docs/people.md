# People: a shared space for someone else

People lets you share a space on your Jantar with one other person in your
household: a partner, a family member, a flatmate, someone you help with
their medicines. They get their own small app on their own address. You can
add to-dos and reminders for them, and see what they agreed to share. They
read exactly what that means before they join, can switch any of it off
later, and can pause, leave or download their data at any time.

People is **off** by default. With it off, nothing about Jantar changes for
you.

> This page describes what is built in this version. Day plans, the evening
> review, alerts, sleep, the journal, their assistant and shared lists are
> later parts of 0.12 and are not offered yet: nobody is asked about them,
> and no setting of yours turns them on. Their medicines (and food, with
> their food module on) are the next part of this one: the fields are in
> the agreement already, and the screens and routes that read them come
> with it.

## Who is who

- **You (the owner)** run Jantar on your Mac. Your devices, the `jantar`
  command and everything you had before stay exactly as they were.
- **Your partner** (the word Jantar uses for the other person, whoever they
  are) has their own devices, their own cookie, their own address, their own
  event stream and their own push list. Their app reaches their own space
  and nothing else of yours: no sessions, accounts, files, Intel, meetings,
  chat, finance or your own Life data.
- You read their space only through your People screens
  (`/v1/people/<id>/…`), each area only while their agreement says so.

## Setting it up

People needs your Mac reachable over HTTPS (`remote.mode` `cloudflare` or
`tailscale`) and a **second hostname** for them, for example
`us.example.com` next to your `jantar.example.com`.

1. Give the second hostname its own Cloudflare Access application (or see
   "Tailscale" below), with a policy that lets in only their email.
2. On the Mac:

   ```sh
   jantar remote people-url https://us.example.com
   jantar people on --name Sam
   jantar people add Asha --email asha@example.com --no-food
   jantar people offer Asha --preset standard
   jantar people invite Asha
   ```

   `people add` prints the Access step to do in Cloudflare (Jantar holds no
   Cloudflare token). `people invite` prints a link that works once, for 24
   hours: send it to them.
3. They open the link, pass Access, read the join page and accept.

Their address is a different origin from yours, on purpose: a page on it can
never write to your routes or open your event stream, and your cookie is
never read there. On their hostname only their routes, `/healthz` and their
app's files answer; everything else is 404. On your hostnames their routes
don't exist.

`jantar people doctor` checks each of these pieces.

### Tailscale

Sharing your Mac with them over Tailscale works too, but exposes every port
your tailnet policy allows a shared-in user. Add a policy rule that limits
`autogroup:shared` to the People port.

## The offer and the agreement

An invite carries an **offer**: a list of fields saying what you would see
and do. A preset fills it, and flags change single fields after it:

```sh
jantar people offer Asha --preset everything --see food=off
```

| Field | Light | Standard (default) | Everything |
| --- | --- | --- | --- |
| see their to-dos and reminders | on | on | on |
| see their medicines | off | full | full |
| see their weight | off | on | on |
| see their food log | off | off | on |
| add to-dos and reminders for them | on | on | on |
| add medicines for them | off | on | on |
| edit or remove to-dos they added | off | off | on |
| edit or stop medicines they added | off | off | on |
| correct or remove a weight they logged | off | off | on |

The preset is only a template: what is stored, shown on the join page and on
their Sharing page is always the list of fields. Medicines have two levels:
**full** (names, doses and each dose) and **only how often** (a percentage,
no names).

The join page lists every field on its own line, in plain words, with a
switch that can only turn it down. Whatever they switch off before joining
is what you get.

After they join:

- **They narrow** at any time under Me › Sharing. It applies before your
  next look, and your screens refresh.
- **You ask for more** from an admin device. They see a card with each field
  that would change and answer Allow or No thanks. One request waits at a
  time; after a No, the same field can't be asked again for 7 days, and
  "Don't ask me about this again" blocks it until they clear it.
- Every step (offered, joined, narrowed, asked, accepted, declined, paused,
  left) is a row in a ledger on your Mac that is only ever appended to.

## Their space

Their to-dos, reminders, projects and weights live in their own space in
your Mac's Life data. Each row remembers who added it.

- **Items you add** show "From Sam" and apply at once. You can mark one "no
  snooze" or ask for a "Got it". They can tick it, undo, snooze (unless you
  said no snooze), skip it with a reason, say Got it, or **Ask to change**
  (you see their note on the item). They can't edit or delete your items.
- **Items they add** are theirs to change. With "edit or remove to-dos they
  added" on, you can change or remove them too: each shows "Edited by Sam",
  and their Activity keeps the old and new value of every field you changed.
- **Weight**: they log it. With "correct or remove a weight they logged" on,
  you can correct or remove a day they logged, never add one.
- **Never in their name.** No screen, route or command of yours ticks their
  items done, snoozes or skips them, logs a weight for them, or pauses,
  resumes or narrows for them.
- **Their reminders ring their devices**, not yours, and open their app.

## What each side sees

- Your People screens show each area they share. An area they keep private
  is a grey tile: "Asha keeps this private". It is never just missing, and
  never counts how long it has been off.
- **See what Sam sees**: under Me › Sharing they can open exactly the view
  you get of each area. Both come from one function, so they can't differ.
- **Activity** (theirs, and readable by you too) lists every change you make
  in their space, each request and answer, devices linked or revoked, and
  every time you look at an area (one line per area per hour, grouped by
  day).
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
  space at once. Remove their email from the Access policy too.
- **People off** (`jantar people off`): your People screens disappear, and
  they can still download their data or leave.

Pause, Leave and Download keep working when People is off, when the daemon
runs read-only, and (Leave and Pause) when Life data can't be opened.

From your phone you can revoke one of their devices (a lost phone), but not
their last one: ending sharing is `jantar people remove` at the Mac, which
gives them their 7 days.

## Devices and notifications (theirs)

- **Link another device**: Me › Devices makes a code that works once, for 5
  minutes; they enter it on the new device at `/p/link`. Five devices at
  most. They see each device's name, when it was last used, and the email it
  joined with; you see names and the email only.
- **Notifications**: turn on and test, mute for an hour or eight, and the
  lock screen: show everything, hide alert text, or hide everything ("Jantar
  · Medicine time"). Their mute is theirs; yours never holds their pushes.

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
  sharing up again.
