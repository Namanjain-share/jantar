# Alerts and sounds

Jantar tells your phone when a session needs you, when one finishes, when a
medicine is due and when something went wrong. Every push belongs to one of
five **alert groups**, and each group has its own tone, chosen per device on
the phone. One new alert, **Answer soon**, is for the asks Claude blocks by
itself after about two minutes.

```sh
jantar notify                  # Web Push, the kinds the Mac sends, the urgent alert, the mute
jantar notify done on          # a push when a session finishes (the success tune)
jantar notify test urgent      # one test push of a group to your devices
```

## What the phone can and cannot do

- **While Jantar is open on screen**, it plays the group's tone (made in
  code, no sound files) and, if you turn it on, says a few fixed words.
  Both follow the ring/silent switch. A push whose tone the app played
  comes without the phone's sound, so you hear one, not two. Answer soon,
  medicine and Life pings always keep the phone's sound (or its buzz with
  the silent switch on), with the app's tone on top. After Jantar was in
  the background, iOS may need one tap before sound plays again, and after
  Jantar starts again its first tap anywhere lets the voice speak. The
  same alert twice within 3 seconds (the countdown's repeat push and its
  60-second mark, or several pings at once) plays once.
- **On the lock screen** (or with Jantar in the background) the iPhone
  plays its own alert sound, the same for every web app (Settings › Sounds
  & Haptics). Jantar can change the words of a push and send a repeat, not
  the sound.
- **Focus**: allow Jantar in your Focus modes (Settings › Focus, then each
  mode's allowed apps) so the urgent alert gets through. Nothing in code
  can do that for you.

## The groups

| Group | When | Tone in the app | Words it may say |
|---|---|---|---|
| **Answer soon** | Claude's 2-minute countdown on an ask nobody answers | Alarm: three short high beeps | "Answer soon" |
| **Needs you** | a permission, a question, a plan, "still waiting", a session started from a phone | Ding: two rising notes | "Claude needs you" |
| **Done** | a session finished its turn | Success: a rising four-note tune | "Done" |
| **Medicines and reminders** | a medicine, a todo or a bill is due | Bell: three soft strikes | "Reminder" |
| **Problems** | a prompt not delivered, a blocked tool, a limit, an API error, usage, a security alert | Low: two falling notes | "Something needs a look" |

Those five phrases are the only words Jantar ever speaks: never what Claude
asked, a folder or a medicine. Pick a tone per group, or none, on the
phone: Devices › Notifications › Sounds ([The app](phone-app.md)). Sounds
are on by default on a phone and off on the Mac's dashboard, where the
microphone of a captured meeting would hear them.

Done pushes are off by default on the Mac. For the success tune, turn them
on at the Mac (`jantar notify done on`) and keep Done on for that device
in Devices › Notifications.

## Answer soon: Claude's 2-minute countdown

An unattended agent's ask (a workflow's or a subagent's) can show
`⚠ Claude Code will automatically block this request in 1:33 …`. Hooks
can't answer it, so it never had a push of its own. Now, when such an ask
turns up, or a session waits with no card, the daemon reads that session's
screen once, the way the phone's Screen tab does. If Claude's countdown is
running with at least 20 seconds left, your phone gets one push:

- **web-app · about 2 min to answer**, with "Claude blocks this ask by
  itself if nobody answers." (with generic bodies: "About 2 min to answer"
  and nothing else). Never the command or the question.
- The time is approximate on purpose: the push is sent once and does not
  tick on the lock screen. It expires with the countdown, so a late push
  never arrives saying "answer now".
- **One repeat** at about a minute left, only if the same ask is still on
  screen. Never a third. Moving the arrow keys at the Mac or resizing the
  window doesn't make it a new ask.
- No separate "needs you" push for that ask: the urgent one covers it. If
  the read fails, or takes longer than 3 seconds, the "needs you" push goes
  anyway: two pushes rather than none.

It goes out as a permission push, so the mute holds it, and a device that
turned permission pushes off gets none. With permission off in the Mac's
kinds there is no urgent alert at all: nothing is read, and the session's
own push goes as before. While muted, or with Web Push off, nothing is read
either. Tap it to open the session; the dock counts the
seconds down and the rows answer the ask
([Answering from the phone](phone-control.md)).

What the read does: at most one screen read per session every 10 seconds,
plus one for the repeat, and one more 10 seconds later if a read for an
ask's card failed. It never types, and nothing it reads is kept, logged or
sent. With the terminal off (`--no-terminal`) there is no urgent alert.
Turn it off with `jantar notify urgent off`; such asks then get the plain
"needs you" push. The daemon remembers which asks it pushed only while it
runs: restarted during a countdown, it may push that ask once more.

## jantar notify

| Command | What it does |
|---|---|
| `jantar notify` | Web Push on or off, the kinds the Mac sends, the urgent alert, the mute |
| `jantar notify urgent on\|off` | the Answer soon push (`notify.urgent`, on by default) |
| `jantar notify done on\|off` | adds or removes `done` in `notify.kinds` |
| `jantar notify test [group]` | one test push of `urgent`, `needs`, `done`, `care` or `problem` (default `needs`) |

```
$ jantar notify
Web Push to devices: on
Kinds the Mac sends: permission, question, plan, send-failed (Done is off: jantar notify done on)
Urgent alert for Claude's 2-minute countdown: on
Muted: no
```

A test push goes to every device by Web Push, past the Mac's kinds and the
mute (you asked for it at the Mac), at most 10 a minute. Each device keeps its own kinds: one
that turned Done off in Devices › Notifications gets no Done test. It says
"Sent to 1 device." or "No device got it." and why (Web Push off, or no
device for it). With Jantar open on the phone, a test plays that group's
tone. The test runs on the Mac only: a phone cannot send one.

The switches change only at the Mac (or from an admin device), like every
`notify` setting ([Configuration](configuration.md)).
