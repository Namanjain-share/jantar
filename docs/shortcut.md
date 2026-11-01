# Save to Jantar from the iPhone's Share sheet

An iOS Shortcut, "Save to Jantar", sends whatever you share (a reel, a
video, a post, an article, a page, or text) to the Intel shelf on your Mac,
which reads it in the background ([Add post](intel.md#add-post-reading-links)).
It answers with one line: **Saved to Jantar.**

It needs three things:

1. Jantar reachable from the iPhone over TLS: **Tailscale** or a
   **Cloudflare** tunnel (`jantar remote setup`). Loopback and LAN modes
   have no door for it (below).
2. The Intel shelf on: `jantar intel on` (and `jantar intel read on` to have
   links read; with reading off the link is still saved, unread).
3. A Shortcut key, made at the Mac.

## Make a key at the Mac

```sh
jantar intel shortcut add --name iphone
```

It prints the key **once** (`jcap_` and 43 letters), the door's address,
and the steps below with your address filled in. Put the key into the
Shortcut right away; Jantar keeps only a hash of it and can never show it
again.

```sh
jantar intel shortcut list               # ids, names, when each was last used; never a key
jantar intel shortcut revoke <id>        # stop one key
jantar intel shortcut revoke --all       # stop every key
```

At most 5 keys are active (a sixth revokes the oldest), and a key unused
for 180 days stops working. Keys are made only at the Mac: a phone, even
an admin one, cannot make, list or revoke them.

## Build the Shortcut

In the Shortcuts app on the iPhone:

1. **+** (new shortcut), name it **Save to Jantar**.
2. Tap **ⓘ** (Details): turn on **Show in Share Sheet**; under it, let it
   receive **URLs**, **Text** and **Safari web pages**; and **If there's no
   input: Get Clipboard**.
3. Optional: **Choose from Menu** with Standard, Light and Full, each
   setting a Text named `Depth` to `standard`, `light` or `full`. Or make a
   second shortcut, "Save to Jantar (Full)", with `full` fixed.
4. **Get Contents of URL**:
   - URL: your door, `https://<your address>/v1/capture/save` (the add
     command printed it)
   - Method: **POST**
   - Headers: `x-jantar-capture-key` = the key; on Cloudflare also
     `CF-Access-Client-Id` and `CF-Access-Client-Secret` (the service
     token, below)
   - Request Body: **JSON**, with `text` = **Shortcut Input** and `depth` =
     `Depth` (or the word `standard`). Everything as text: Jantar finds the
     link in it, and the rest becomes the item's note.
5. **Get Dictionary Value** for the key `message`, then **Show
   Notification** with it.

Share a reel from Instagram (or a page from Safari, a video from YouTube),
pick **Save to Jantar**: "Saved to Jantar." The phone's Intel shelf shows
it at once under Reading.

**Never share this Shortcut.** It carries the key (and on Cloudflare the
Access token). iCloud syncs it only to your own devices.

## The door

| `remote.mode` | The door | What the Shortcut needs |
|---|---|---|
| `tailscale` | `https://<mac>.<tailnet>.ts.net/v1/capture/save` | Tailscale on in the iPhone; the key |
| `cloudflare` | `https://<your host>/v1/capture/save` | the key, and an Access service token for the door ([below](#cloudflare-access)) |
| `loopback` | none | the iPhone cannot reach the Mac |
| `lan` | none | LAN mode is plain http: the key would cross the Wi-Fi in clear |

The door exists only while all of this holds: a TLS mode, the shelf on and
an active key. Otherwise `POST /v1/capture/save` is a plain 404, as if
there were no such route.

### Cloudflare Access

The Shortcut cannot sign in to Cloudflare Access with your e-mail, so the
door gets the same kind of door Fleet's servers use: its own Access
application and its own service token, so revoking one never breaks the
other.

1. Zero Trust › Access › Service auth › **Create service token**, named
   `jantar-capture`. Copy the Client ID and Client Secret (shown once); set
   an expiry you will remember.
2. Zero Trust › Access › Applications › **Add an application** ›
   Self-hosted: domain `<your host>`, path `/v1/capture/*`.
3. Its only policy: Action **Service Auth**, Include **Service Token**
   `jantar-capture`. Never Allow, never Bypass.
4. In the Shortcut's headers: `CF-Access-Client-Id` and
   `CF-Access-Client-Secret`.

`jantar doctor` checks the door while a key exists: it sends one request
to `https://<your host>/v1/capture/save` with no token, and warns when
Jantar answers it (no Access in front) or Access answers with a login page
(the Shortcut cannot pass that). Access refusing it (403) is right.

## What the door does, and does not

- It only saves and queues a read. It never lists, opens or deletes
  anything, and it answers with the same sentence, byte for byte, for a new
  link, a link already saved, reading turned off and a read over today's
  cap: a leaked key can't learn what you saved.
- A link that is not public https (a local address, a port, a name with no
  dot) is refused with "Only public https links can be read." and nothing
  is saved.
- Limits: 30 saves an hour and 200 a day per key; 20 wrong keys in 10
  minutes from one address and that address waits.
- Browsers can't call it (any `Origin` header is refused), a phone's
  pairing cookie means nothing there, and the key works nowhere else in
  Jantar.
- The key is never logged, audited or put in a URL; the audit log names
  each save `capture.save` with the key's id.

## When it doesn't work

| The Shortcut shows | Why | What to do |
|---|---|---|
| A web page (HTML) instead of a message | Cloudflare Access refused it: the service token is missing, wrong or expired | check the two `CF-Access-…` headers; make a new token |
| `401` | the key is missing, mistyped, revoked or older than 180 days unused | `jantar intel shortcut add`, and put the new key in |
| `404` | the door is closed: loopback or LAN mode, the shelf off, or no active key | `jantar intel shortcut list`, `jantar intel on`, `jantar remote setup` |
| `403` | the request carried an `Origin` (it came from a browser, not Shortcuts) | send it from the Shortcut |
| `429` | too many saves in the hour (or the day), or too many wrong keys | wait; the reply says how long |
| `400` "Only public https links can be read." | the link points inside a network | share the public link |
| It times out | the Mac is asleep, or the tunnel or Tailscale is down | wake the Mac; `jantar doctor` |

The saved item shows at once on the phone; if it says "Couldn't read",
its reason and **Retry** are there.
