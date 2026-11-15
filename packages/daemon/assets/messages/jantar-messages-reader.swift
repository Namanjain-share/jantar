// jantar-messages-reader: Jantar's WhatsApp reader (0.15 Messages).
//
// The one program that opens WhatsApp for Mac's files, read-only. It runs as
// its own LaunchAgent and answers a fixed set of questions for the daemon on
// a 0600 Unix socket, one JSON object per line (reader-protocol.ts):
//
//   {"id":1,"op":"chats","args":{"limit":30}}
//     -> {"id":1,"ok":true,"data":{…}} | {"id":1,"ok":false,"error":"not_found","detail":"…"}
//
//   status                                      {whatsapp: {found, running, schemaOk, contactsOk, newestAt, walMtime},
//                                                phone: {readable}, skipped, skipOk, skipUnmatched?, version}
//   chats      {q?, since?, limit, waiting?}    {chats: [chat (+phone)], total}
//   read       {chatKey, since?, before?, limit} {chat, messages (oldest first), more}
//                                                (next page: before = messages[0].at; see read())
//   readByName {name, since?, before?, limit}   a read's answer, or {ambiguous: [chat], total}
//   search     {q, since?, chatKey?, limit}     {hits: [{chatKey, chatName, msgKey, at, fromMe, sender, snippet}]}
//                                                (newest first; 90 days back without since)
//   newSince   {cursor: {pk, at} | null, guardHours, firstRunHours, maxRows}
//                                                {chats: [{chat (+phone), messages, earlier}], nextCursor, truncated, reset}
//   lastFromMe {chatKeys}                       {[chatKey]: the owner's last line's time | null}
//   media      {msgKey, maxBytes}               {file (<state>/spool/…), bytes, kind, mime, fileName?}
//   waCalls    {since}                          {calls: [call]} (WhatsApp's CallHistory.sqlite)
//   phoneCalls {since}                          {calls: [call]} (the iPhone call log: needs Full Disk Access)
//
//   jantar-messages-reader --container <dir> --phone-db <file> --socket <path> --state <dir> [--now <iso>]
//   (exit 64 on bad arguments; --now is for tests)
//
// Rules:
// - A connection whose peer uid isn't ours (getpeereid) is closed unanswered.
// - No SQL from outside, no network, no child processes.
// - Every database opens SQLITE_OPEN_READONLY with mode=ro and query_only,
//   never immutable (WhatsApp keeps writing); each request runs under a
//   deadline (progress handler) and connections close after 30 s idle.
//   Nothing in WhatsApp's folder is written, moved or deleted (SQLite may
//   create an -shm file beside a database: the one footprint). macOS's
//   SQLite opens a WAL database read-only only while its -wal is there:
//   without it (WhatsApp closed) reads answer `busy` and status's times are null.
// - Every column read is checked at open (PRAGMA table_info): one missing and
//   reads answer `unsupported` rather than wrong rows.
// - WhatsApp's ids never leave: a chat is "c" + 16 hex of HMAC-SHA256(salt,
//   its id), a message its chat's key + "." + its stanza id. The salt (32
//   random bytes, <state>/salt, 0600) is made once and never replaced:
//   deleted while the reader runs, it is written again from memory; missing
//   at start while skip.json names chats (or won't parse), the reader won't
//   start, since new keys would match none of them. A mention (WhatsApp
//   stores "@" + the id's digits) becomes "@" + a name.
// - The skip list (<state>/skip.json, the daemon's) is reloaded when it
//   changes, checked on every request. A skipped 1:1 hides that person
//   everywhere: their chats under either id (@lid or number), their lines
//   in groups ("[skipped]") and mentions of them ("@[skipped]"); a skipped
//   group hides the group. A group sender, a mention, a call's people and
//   an iPhone number are also matched by their own id's key, so a skip holds
//   after its 1:1 is gone from WhatsApp. A skipped chat is `not_found`. A
//   skip list that won't parse refuses reads (`busy`, status `skipOk:
//   false`) rather than read everything; so does a missing LID.sqlite or
//   ContactsV2.sqlite while anything is skipped and anyone is named by an
//   @lid (`no_access`, `contactsOk: false`): their links are what find a
//   skipped person's @lid.
// - Status, channels, broadcast lists, removed and hidden chats are left out.
//   The chat's unsent-draft and last-message-preview columns are never read.
// - A search runs under a 5 s deadline; a hit is checked again on the line
//   as it is shown, so an id's digits inside a mention never match.
// - The morning feed (newSince) goes by row id, never further back than
//   guardHours; a cursor above the newest row id (WhatsApp renumbered its
//   rows when re-linked) starts over with firstRunHours.
// - A media file is copied (never moved) into <state>/spool, 0600; the
//   reader deletes copies older than 10 minutes.
// - stderr carries no text, name, id or number.

import AppKit
import CommonCrypto
import Foundation
import SQLite3

// ---------------------------------------------------------------- constants

let READER_VERSION = 1
let EX_USAGE: Int32 = 64
let EX_FAIL: Int32 = 1

/// ZWACHATSESSION.ZSESSIONTYPE.
let SESSION_DM = 0
let SESSION_GROUP = 1
let SESSION_BROADCAST = 2
let SESSION_STATUS = 3
let SESSION_COMMUNITY = 4
let SESSION_NEWSLETTER = 5

/// ZWAMESSAGE.ZMESSAGETYPE, from the owner's own data (Task 0). Any other
/// type: non-empty text is "text", else "other". 14 is taken as a revoked
/// message where Task 0 left it "other" (unclear): it carries no text either
/// way. The real-Mac checks confirm it.
let MESSAGE_KINDS: [Int: String] = [
  0: "text", 1: "image", 2: "video", 3: "voice", 4: "contact", 5: "location", 6: "system", 7: "link",
  8: "document", 10: "system", 11: "gif", 12: "system", 14: "deleted", 15: "sticker", 19: "system",
  46: "system", 59: "system", 66: "poll", 68: "system", 75: "system",
]
let MEDIA_KINDS: Set<String> = ["image", "video", "voice", "document", "sticker", "gif"]
let CAPTIONED_KINDS: Set<String> = ["image", "video", "gif", "link"]
/// Kinds whose lines carry no text out (a system line may hold ids).
let SILENT_KINDS: Set<String> = ["system", "deleted", "reaction"]
/// Their types, for SQL: none of them counts as a chat's last line.
let SILENT_TYPES = MESSAGE_KINDS.filter { SILENT_KINDS.contains($0.value) }.map { String($0.key) }.sorted().joined(separator: ", ")

let WHATSAPP_BUNDLE = "net.whatsapp.WhatsApp"
let USER_SUFFIX = "@s.whatsapp.net"
let LID_SUFFIX = "@lid"
let GROUP_SUFFIX = "@g.us"
let LEFT_OUT_SUFFIXES = ["@broadcast", "@newsletter"]
let ME = "Me"
let UNKNOWN = "Unknown"
let SKIPPED = "[skipped]"

let SALT_BYTES = 32
/// Why the reader won't start (stderr): `jantar messages skip reset` is the way on.
let SALT_LOST = "the salt is gone and the skip list still lists chats; nothing is read until the skip list is reset at the Mac: jantar messages skip reset"
let KEY_HEX = 16
let STANZA_MAX = 64
let PHONE_MAX = 20
let REQUEST_NS: UInt64 = 2_000_000_000
let BUSY_TIMEOUT_MS: Int32 = 200
let PROGRESS_STEPS: Int32 = 1_000
let IDLE_CLOSE_S: TimeInterval = 30
let POLL_TICK_MS: Int32 = 5_000
let LINE_MAX = 64 * 1024
let SKIP_FILE_MAX = 4 * 1024 * 1024
let CLIENTS_MAX = 16
let LISTEN_BACKLOG: Int32 = 16
let SEND_TIMEOUT_S = 5
/// MESSAGES_LIMITS.readMax, GET /v1/messages/chats's most, a name's longest.
let READ_MAX = 200
let CHATS_MAX = 200
let NAME_MAX = 100
let CHATS_DEFAULT = 30
let READ_DEFAULT = 50
/// MESSAGES_LIMITS.waitingDays.
let WAITING_S: TimeInterval = 3 * 86_400
let AMBIGUOUS_MAX = 20
/// The fewest digits after "@" that make a mention (an id: country code and number, or an @lid).
let MENTION_DIGITS_MIN = 8
/// MESSAGES_LIMITS.searchMax, a search's longest text, how far back it looks without `since`, its deadline.
let SEARCH_MAX = 50
let SEARCH_DEFAULT = 20
let QUERY_MAX = 200
let SEARCH_BACK_MS: Int64 = 90 * 86_400_000
let SEARCH_NS: UInt64 = 5_000_000_000
/// A hit's snippet: at most this many characters around the match.
let SNIPPET_CHARS = 160
/// newSince: lines kept before a chat's first new one, the most lines in one answer, the longest window.
let EARLIER_MAX = 10
let NEW_ROWS_MAX = 20_000
let HOURS_MAX = 720
let MS_PER_HOUR: Int64 = 3_600_000
/// lastFromMe: the most chat keys in one request.
let KEYS_MAX = 500
/// MESSAGES_LIMITS.mediaMaxBytes; how long a spool copy lives; how often the spool is swept between requests.
let MEDIA_MAX_BYTES = 25 * 1024 * 1024
let SPOOL_TTL_S: TimeInterval = 600
let SPOOL_SWEEP_S: TimeInterval = 60
let SPOOL_NAME_BYTES = 16
let EXT_MAX = 8
/// A copy's type, by its file's extension; a kind's extension when the file has none.
let MIME_BY_EXT: [String: String] = [
  "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "heic": "image/heic", "webp": "image/webp", "gif": "image/gif",
  "mp4": "video/mp4", "mov": "video/quicktime", "m4v": "video/x-m4v", "opus": "audio/ogg", "ogg": "audio/ogg", "m4a": "audio/mp4",
  "mp3": "audio/mpeg", "aac": "audio/aac", "pdf": "application/pdf",
]
let EXT_BY_KIND: [String: String] = ["image": "jpg", "video": "mp4", "gif": "mp4", "voice": "opus", "sticker": "webp"]
let MIME_DEFAULT = "application/octet-stream"
/// The most calls in one answer (the newest).
let CALLS_MAX = 500
/// ZCALLRECORD.ZCALLTYPE of a FaceTime video call.
let PHONE_CALL_VIDEO = 8
/// A number's last digits, which name it however it was dialled (with +91, a 0 or neither).
let NUMBER_SUFFIX_DIGITS = 10
/// An Indian mobile with its country code, shown "+91 99900 00002" (two groups of five).
let INDIA_CODE = "91"
let INDIA_DIGITS = 12
let INDIA_GROUP = 5
let NUMBER_CHARS = Set("+0123456789 -().".unicodeScalars)

// ---------------------------------------------------------------- output and failures

struct Failure: Error {
  let code: String
  let detail: String?
  init(_ code: String, _ detail: String? = nil) {
    self.code = code
    self.detail = detail
  }
}

func bad(_ what: String) -> Failure { Failure("bad_request", what) }

func log(_ line: String) {
  FileHandle.standardError.write(Data("jantar-messages-reader: \(line)\n".utf8))
}

func fatal(_ why: String) -> Never {
  log(why)
  exit(EX_FAIL)
}

func usage(_ why: String) -> Never {
  log("\(why)\nusage: jantar-messages-reader --container <dir> --phone-db <file> --socket <path> --state <dir> [--now <iso>]")
  exit(EX_USAGE)
}

// ---------------------------------------------------------------- times

let isoFrac: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  f.timeZone = TimeZone(identifier: "UTC")
  return f
}()
let isoPlain: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  f.timeZone = TimeZone(identifier: "UTC")
  return f
}()

func parseIso(_ s: String) -> Date? { isoFrac.date(from: s) ?? isoPlain.date(from: s) }

/// Core Data seconds (since 2001-01-01Z) cut down to the millisecond, the
/// finest time a reply carries. SQL's `ZMESSAGEDATE * 1000 >= ms` is the same cut.
func appleMs(_ seconds: Double) -> Int64 { Int64((seconds * 1000).rounded(.down)) }

/// Core Data seconds as ISO, cut down to the millisecond: a time read back
/// as `before` then never includes the message it came from.
func isoApple(_ seconds: Double) -> String { isoMs(appleMs(seconds)) }

/// Core Data milliseconds as ISO.
func isoMs(_ ms: Int64) -> String { isoFrac.string(from: Date(timeIntervalSinceReferenceDate: Double(ms) / 1000)) }

func isoUnix(_ ts: timespec) -> String {
  isoApple(Double(ts.tv_sec) + Double(ts.tv_nsec) / 1e9 - Date.timeIntervalBetween1970AndReferenceDate)
}

// ---------------------------------------------------------------- options

struct Options {
  let container: String
  let phoneDb: String
  let socket: String
  let state: String
  let now: Date?
}

func parseOptions(_ argv: [String]) -> Options {
  let known: Set<String> = ["--container", "--phone-db", "--socket", "--state", "--now"]
  var values: [String: String] = [:]
  var i = 0
  while i < argv.count {
    let flag = argv[i]
    guard known.contains(flag), i + 1 < argv.count, values[flag] == nil else { usage("bad arguments") }
    values[flag] = argv[i + 1]
    i += 2
  }
  func path(_ flag: String) -> String {
    guard let v = values[flag], v.hasPrefix("/"), !v.contains("\0") else { usage("\(flag) needs an absolute path") }
    return v
  }
  var now: Date?
  if let n = values["--now"] {
    guard let d = parseIso(n) else { usage("--now needs an ISO time") }
    now = d
  }
  let socket = path("--socket")
  guard socket.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else { usage("--socket path is too long") }
  return Options(container: path("--container"), phoneDb: path("--phone-db"), socket: socket, state: path("--state"), now: now)
}

// ---------------------------------------------------------------- files

enum FileState { case present, missing, denied }

func fileState(_ path: String) -> FileState {
  var st = stat()
  if stat(path, &st) == 0 { return (st.st_mode & S_IFMT) == S_IFREG ? .present : .denied }
  return errno == ENOENT || errno == ENOTDIR ? .missing : .denied
}

func mtime(_ path: String) -> String? {
  var st = stat()
  guard stat(path, &st) == 0 else { return nil }
  return isoUnix(st.st_mtimespec)
}

/// `salt` written to `path` (0600) through a temp file and link(), so a
/// second reader never replaces the first's: true when it is there (EEXIST:
/// another got there first).
func publishSalt(_ path: String, _ salt: [UInt8]) -> Bool {
  let tmp = "\(path).\(getpid()).tmp"
  let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  guard fd >= 0 else { return false }
  let wrote = write(fd, salt, salt.count)
  let synced = fsync(fd)
  close(fd)
  let linked = wrote == salt.count && synced == 0 ? link(tmp, path) : -1
  let linkErr = errno
  unlink(tmp)
  return linked == 0 || linkErr == EEXIST
}

/// <state> (0700, made if missing) and its salt: 32 random bytes made once.
/// Every key on the skip list was made with it: a new one over a list that
/// names chats (or won't parse) would match none of them, so the reader
/// stops instead, until the list is reset at the Mac.
func loadSalt(_ state: String) -> [UInt8] {
  var st = stat()
  if lstat(state, &st) != 0 {
    guard errno == ENOENT, mkdir(state, 0o700) == 0 else { fatal("the state dir can't be made") }
  } else if (st.st_mode & S_IFMT) != S_IFDIR || st.st_uid != getuid() || chmod(state, 0o700) != 0 {
    fatal("the state dir isn't a folder of ours")
  }
  let path = state + "/salt"
  if lstat(path, &st) != 0 {
    guard errno == ENOENT else { fatal("the salt can't be read") }
    let skip = SkipList(state)
    skip.refresh()
    guard !skip.broken, skip.keys.isEmpty else { fatal(SALT_LOST) }
    var fresh = [UInt8](repeating: 0, count: SALT_BYTES)
    arc4random_buf(&fresh, SALT_BYTES)
    guard publishSalt(path, fresh) else { fatal("the salt can't be made") }
  }
  let fd = open(path, O_RDONLY | O_NOFOLLOW)
  guard fd >= 0, fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), st.st_size == SALT_BYTES else {
    // Never replaced: every key, and so the skip list, depends on it.
    fatal("the salt is damaged; nothing is read until it is fixed")
  }
  var salt = [UInt8](repeating: 0, count: SALT_BYTES)
  let got = read(fd, &salt, SALT_BYTES)
  close(fd)
  guard got == SALT_BYTES else { fatal("the salt can't be read") }
  return salt
}

// ---------------------------------------------------------------- keys and ids

let HEX = Array("0123456789abcdef".utf8)

/// `prefix` and 16 hex of HMAC-SHA256(salt, id): "c…" a chat, "k…" a call.
func hmacKey(_ salt: [UInt8], _ id: String, prefix: UInt8 = UInt8(ascii: "c")) -> String {
  var mac = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
  let data = Array(id.utf8)
  CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), salt, salt.count, data, data.count, &mac)
  var out: [UInt8] = [prefix]
  for b in mac.prefix(KEY_HEX / 2) {
    out.append(HEX[Int(b >> 4)])
    out.append(HEX[Int(b & 0xf)])
  }
  return String(decoding: out, as: UTF8.self)
}

func randomHex(_ bytes: Int) -> String {
  var raw = [UInt8](repeating: 0, count: bytes)
  arc4random_buf(&raw, bytes)
  return String(decoding: raw.flatMap { [HEX[Int($0 >> 4)], HEX[Int($0 & 0xf)]] }, as: UTF8.self)
}

func isChatKey(_ s: String) -> Bool {
  let u = Array(s.utf8)
  return u.count == KEY_HEX + 1 && u[0] == UInt8(ascii: "c") && u.dropFirst().allSatisfy { HEX.contains($0) }
}

func isAsciiDigits(_ s: Substring) -> Bool { !s.isEmpty && s.utf8.allSatisfy { $0 >= 48 && $0 <= 57 } }

/// A message's key: its chat's key and stanza id; a row without a usable
/// stanza id falls back to "_" + its row id (not stable across a re-link).
func msgKey(_ chatKey: String, _ stanza: String?, _ pk: Int64) -> String {
  if let s = stanza, (1...STANZA_MAX).contains(s.utf8.count),
     s.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 }) {
    return "\(chatKey).\(s)"
  }
  return "\(chatKey)._\(pk)"
}

/// "<digits>@s.whatsapp.net" from a jid, bare digits or a formatted number.
func userJid(_ raw: String?) -> String? {
  guard let raw, !raw.isEmpty else { return nil }
  if raw.hasSuffix(USER_SUFFIX) { return raw }
  if raw.contains("@") { return nil }
  let digits = String(raw.unicodeScalars.filter { $0.value >= 48 && $0.value <= 57 }.map(Character.init))
  return digits.isEmpty ? nil : digits + USER_SUFFIX
}

/// `address` (lower case) when it is one of WhatsApp's ids (a person, a group, a list), which never leave the reader.
/// A device part (":<digits>" before the "@", as WhatsApp writes a linked device's id) is dropped: it is that person.
func whatsAppId(_ address: String) -> String? {
  let id = address.lowercased()
  guard ([USER_SUFFIX, LID_SUFFIX, GROUP_SUFFIX] + LEFT_OUT_SUFFIXES).contains(where: { id.hasSuffix($0) }) else { return nil }
  guard let at = id.firstIndex(of: "@"), let colon = id[..<at].firstIndex(of: ":"),
        isAsciiDigits(id[id.index(after: colon)..<at]) else { return id }
  return String(id[..<colon]) + String(id[at...])
}

func lidJid(_ raw: String?) -> String? {
  guard let raw, !raw.isEmpty else { return nil }
  if raw.hasSuffix(LID_SUFFIX) { return raw }
  return isAsciiDigits(Substring(raw)) ? raw + LID_SUFFIX : nil
}

func nonEmpty(_ s: String?) -> String? {
  guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
  return s
}

func digitsIn(_ s: String) -> String { String(s.unicodeScalars.filter { $0.value >= 48 && $0.value <= 57 }.map(Character.init)) }

/// A number as people write it: "+91 99900 00002" for an Indian mobile,
/// else "+" and its digits (as dialled when it had no country code);
/// anything that isn't a number (a FaceTime address) as it is.
func formatNumber(_ raw: String) -> String {
  let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  let digits = digitsIn(t)
  guard !digits.isEmpty, t.unicodeScalars.allSatisfy({ NUMBER_CHARS.contains($0) }) else { return t.isEmpty ? UNKNOWN : t }
  let international = t.hasPrefix("+") || (digits.count > NUMBER_SUFFIX_DIGITS && !digits.hasPrefix("0"))
  guard international else { return digits }
  if digits.count == INDIA_DIGITS, digits.hasPrefix(INDIA_CODE) {
    let d = Array(digits.dropFirst(INDIA_CODE.count))
    return "+\(INDIA_CODE) \(String(d[..<INDIA_GROUP])) \(String(d[INDIA_GROUP...]))"
  }
  return "+" + digits
}

/// `q` for `LIKE '%' || ? || '%' ESCAPE '\'`: its own %, _ and \ taken literally.
func likeEscaped(_ q: String) -> String {
  var out = ""
  for c in q {
    if c == "%" || c == "_" || c == "\\" { out.append("\\") }
    out.append(c)
  }
  return out
}

/// Core Data seconds a millisecond below `ms`: a bound the date index can
/// use, beside the exact `ZMESSAGEDATE * 1000` test (float slack either way).
func indexBound(_ ms: Int64) -> Double { Double(ms - 1) / 1000 }

/// `text` around its first case-insensitive match of `q`, at most
/// SNIPPET_CHARS characters ("…" where cut); nil when it doesn't hold `q`.
func snippet(_ text: String, _ q: String) -> String? {
  guard let r = text.range(of: q, options: .caseInsensitive) else { return nil }
  let total = text.count
  guard total > SNIPPET_CHARS else { return text }
  let before = text.distance(from: text.startIndex, to: r.lowerBound)
  let len = text.distance(from: r.lowerBound, to: r.upperBound)
  let lead = max(0, min(before - max(0, SNIPPET_CHARS - len) / 2, total - SNIPPET_CHARS))
  let start = text.index(text.startIndex, offsetBy: lead)
  let end = text.index(start, offsetBy: SNIPPET_CHARS, limitedBy: text.endIndex) ?? text.endIndex
  return (lead > 0 ? "…" : "") + text[start..<end] + (end < text.endIndex ? "…" : "")
}

// ---------------------------------------------------------------- sqlite

let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// The running request's deadline (uptime ns); the progress handler stops a statement past it.
var deadlineNs: UInt64 = .max

let progressHandler: @convention(c) (UnsafeMutableRawPointer?) -> Int32 = { _ in
  DispatchTime.now().uptimeNanoseconds > deadlineNs ? 1 : 0
}

func sqlFailure(_ rc: Int32, _ what: String) -> Failure {
  switch rc & 0xff {
  case SQLITE_INTERRUPT: return Failure("timeout", what)
  // READONLY covers READONLY_RECOVERY and _CANTINIT: a read-only WAL
  // connection meeting WhatsApp mid-recovery. Passing, like the rest.
  case SQLITE_BUSY, SQLITE_LOCKED, SQLITE_IOERR, SQLITE_READONLY, SQLITE_PROTOCOL, SQLITE_NOMEM: return Failure("busy", what)
  case SQLITE_CANTOPEN, SQLITE_PERM, SQLITE_AUTH: return Failure("no_access", "macOS refused \(what) to the reader")
  default: return Failure("unsupported", "\(what): sqlite \(rc)")
  }
}

/// A file: URI's path, every byte outside [A-Za-z0-9/._~-] percent-encoded.
func uriPath(_ path: String) -> String {
  var out = ""
  for b in path.utf8 {
    switch b {
    case 48...57, 65...90, 97...122, 47, 46, 95, 126, 45: out.unicodeScalars.append(Unicode.Scalar(b))
    default: out += String(format: "%%%02X", UInt32(b))
    }
  }
  return out
}

final class Statement {
  let stmt: OpaquePointer
  let what: String

  init(_ db: OpaquePointer, _ sql: String, _ what: String) throws {
    var s: OpaquePointer?
    let rc = sqlite3_prepare_v2(db, sql, -1, &s, nil)
    guard rc == SQLITE_OK, let s else {
      if let s { sqlite3_finalize(s) }
      // A column or table WhatsApp no longer has.
      throw rc == SQLITE_ERROR ? Failure("unsupported", "\(what): a query no longer fits") : sqlFailure(rc, what)
    }
    stmt = s
    self.what = what
  }

  deinit { sqlite3_finalize(stmt) }

  @discardableResult
  func bind(_ values: Any?...) -> Statement { bindAll(values) }

  @discardableResult
  func bindAll(_ values: [Any?]) -> Statement {
    for (i, v) in values.enumerated() {
      let idx = Int32(i + 1)
      switch v {
      case let n as Int64: sqlite3_bind_int64(stmt, idx, n)
      case let n as Int: sqlite3_bind_int64(stmt, idx, Int64(n))
      case let d as Double: sqlite3_bind_double(stmt, idx, d)
      case let s as String: sqlite3_bind_text(stmt, idx, s, Int32(s.utf8.count), SQLITE_TRANSIENT)
      default: sqlite3_bind_null(stmt, idx)
      }
    }
    return self
  }

  func step() throws -> Bool {
    let rc = sqlite3_step(stmt)
    if rc == SQLITE_ROW { return true }
    if rc == SQLITE_DONE { return false }
    throw sqlFailure(rc, what)
  }

  func isNull(_ i: Int32) -> Bool { sqlite3_column_type(stmt, i) == SQLITE_NULL }
  func int(_ i: Int32) -> Int64 { sqlite3_column_int64(stmt, i) }
  func double(_ i: Int32) -> Double { sqlite3_column_double(stmt, i) }
  func intOrNil(_ i: Int32) -> Int64? { isNull(i) ? nil : int(i) }

  func text(_ i: Int32) -> String? {
    guard let p = sqlite3_column_text(stmt, i) else { return nil }
    return String(decoding: UnsafeBufferPointer(start: p, count: Int(sqlite3_column_bytes(stmt, i))), as: UTF8.self)
  }
}

final class Database {
  let handle: OpaquePointer
  let what: String
  var lastUsed = Date()

  private init(_ handle: OpaquePointer, _ what: String) {
    self.handle = handle
    self.what = what
  }

  deinit { sqlite3_close_v2(handle) }

  /// Read-only: SQLITE_OPEN_READONLY, mode=ro, query_only; never immutable.
  static func open(_ path: String) throws -> Database {
    let what = (path as NSString).lastPathComponent
    var h: OpaquePointer?
    let rc = sqlite3_open_v2("file:\(uriPath(path))?mode=ro", &h, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_URI, nil)
    guard rc == SQLITE_OK, let h else {
      if let h { sqlite3_close_v2(h) }
      throw sqlFailure(rc, what)
    }
    let db = Database(h, what)
    sqlite3_busy_timeout(h, BUSY_TIMEOUT_MS)
    sqlite3_progress_handler(h, PROGRESS_STEPS, progressHandler, nil)
    let q = sqlite3_exec(h, "PRAGMA query_only = 1", nil, nil, nil)
    guard q == SQLITE_OK else { throw sqlFailure(q, what) }
    // The open is lazy: reading the schema is what meets macOS's refusal.
    do {
      _ = try db.prepare("SELECT count(*) FROM sqlite_master").step()
    } catch let f as Failure where f.code == "no_access" && sqlite3_system_errno(h) == ENOENT {
      // macOS's SQLite opens a WAL database read-only only with its -wal
      // there, and never makes one: WhatsApp's is gone while WhatsApp is
      // closed (the reader writes nothing in its folder to stand in).
      throw Failure("busy", "\(what) is closed: open WhatsApp")
    }
    return db
  }

  func prepare(_ sql: String) throws -> Statement { try Statement(handle, sql, what) }

  func dataVersion() throws -> Int64 {
    let s = try prepare("PRAGMA data_version")
    return try s.step() ? s.int(0) : -1
  }

  /// "TABLE.COLUMN" for every column in `tables` this file doesn't have.
  func missingColumns(_ tables: [(String, [String])]) throws -> [String] {
    var missing: [String] = []
    for (table, cols) in tables {
      let s = try prepare("PRAGMA table_info(\"\(table)\")")
      var have = Set<String>()
      while try s.step() { if let n = s.text(1) { have.insert(n) } }
      missing += cols.filter { !have.contains($0) }.map { "\(table).\($0)" }
    }
    return missing
  }
}

/// One of WhatsApp's databases: opened on first use, its columns checked,
/// closed after IDLE_CLOSE_S without a request.
final class Source {
  let path: String
  let tables: [(String, [String])]
  let required: Bool
  private(set) var db: Database?
  private(set) var generation = 0

  init(_ path: String, _ tables: [(String, [String])], required: Bool) {
    self.path = path
    self.tables = tables
    self.required = required
  }

  /// Nil when an optional file isn't there.
  func get() throws -> Database? {
    if let db {
      db.lastUsed = Date()
      return db
    }
    let name = (path as NSString).lastPathComponent
    switch fileState(path) {
    case .missing:
      if required { throw Failure("no_access", "\(name) isn't there: is WhatsApp for Mac installed and signed in?") }
      return nil
    case .denied: throw Failure("no_access", "macOS refused \(name) to the reader")
    case .present: break
    }
    let d = try Database.open(path)
    let missing = try d.missingColumns(tables)
    guard missing.isEmpty else { throw Failure("unsupported", "\(name) lacks \(missing.prefix(3).joined(separator: ", "))") }
    db = d
    generation += 1
    return d
  }

  func closeIfIdle(_ now: Date) {
    if let db, now.timeIntervalSince(db.lastUsed) > IDLE_CLOSE_S { self.db = nil }
  }
}

// ---------------------------------------------------------------- what is read

let CHAT_TABLES: [(String, [String])] = [
  ("ZWACHATSESSION", ["Z_PK", "ZCONTACTJID", "ZPARTNERNAME", "ZSESSIONTYPE", "ZUNREADCOUNT", "ZARCHIVED", "ZLASTMESSAGEDATE", "ZREMOVED", "ZHIDDEN"]),
  ("ZWAMESSAGE", ["Z_PK", "ZCHATSESSION", "ZSORT", "ZISFROMME", "ZMESSAGETYPE", "ZGROUPMEMBER", "ZMEDIAITEM", "ZPARENTMESSAGE",
                  "ZMESSAGEDATE", "ZSTANZAID", "ZTEXT"]),
  ("ZWAMEDIAITEM", ["Z_PK", "ZFILESIZE", "ZMOVIEDURATION", "ZMEDIALOCALPATH", "ZTITLE", "ZVCARDNAME"]),
  ("ZWAGROUPMEMBER", ["Z_PK", "ZCHATSESSION", "ZMEMBERJID", "ZCONTACTNAME", "ZFIRSTNAME", "ZISACTIVE", "ZISADMIN"]),
  ("ZWAPROFILEPUSHNAME", ["ZJID", "ZPUSHNAME"]),
]
let CONTACT_TABLES: [(String, [String])] = [("ZWAADDRESSBOOKCONTACT", ["ZFULLNAME", "ZWHATSAPPID", "ZLID"])]
let LID_TABLES: [(String, [String])] = [("ZWAZACCOUNT", ["ZIDENTIFIER", "ZPHONENUMBER"])]
/// WhatsApp's CallHistory.sqlite, as on the real Mac: a call (aggregate, one
/// row per call), its attempts (Z1CALLEVENTS -> the call), and the other
/// people on it (Z1PARTICIPANTS -> the call, not an attempt).
let WA_CALL_TABLES: [(String, [String])] = [
  ("ZWAAGGREGATECALLEVENT", ["Z_PK", "ZINCOMING", "ZMISSED", "ZVIDEO", "ZFIRSTDATE"]),
  ("ZWACDCALLEVENT", ["Z_PK", "Z1CALLEVENTS", "ZDATE", "ZDURATION", "ZCALLIDSTRING", "ZGROUPJIDSTRING", "ZGROUPCALLCREATORUSERJIDSTRING"]),
  ("ZWACDCALLEVENTPARTICIPANT", ["Z1PARTICIPANTS", "ZJIDSTRING"]),
]
/// The iPhone call log (CallHistory.storedata).
let PHONE_TABLES: [(String, [String])] = [("ZCALLRECORD", ["ZADDRESS", "ZDATE", "ZDURATION", "ZORIGINATED", "ZANSWERED", "ZCALLTYPE"])]
/// Read when there: which app logged a call (WhatsApp's are left out).
let PHONE_PROVIDER: [(String, [String])] = [("ZCALLRECORD", ["ZSERVICE_PROVIDER"])]
/// Read when there: an address-book contact's own number (CONTACT_TABLES must not need it).
let CONTACT_PHONE: [(String, [String])] = [("ZWAADDRESSBOOKCONTACT", ["ZPHONENUMBER"])]

/// One line and what it points at, for every query that answers lines
/// (lineOut reads these columns by index: 0-5 the line, 6-8 its parent,
/// 9-14 its media, 15-17 its group sender, 18 its chat, 19 its place in it,
/// 20 whether its parent is the owner's).
let LINE_SELECT = """
  SELECT m.Z_PK, m.ZISFROMME, m.ZMESSAGETYPE, m.ZMESSAGEDATE, m.ZSTANZAID, m.ZTEXT,
         p.Z_PK, p.ZSTANZAID, p.ZCHATSESSION,
         mi.Z_PK, mi.ZFILESIZE, mi.ZMOVIEDURATION, mi.ZMEDIALOCALPATH, mi.ZTITLE, mi.ZVCARDNAME,
         gm.ZMEMBERJID, gm.ZCONTACTNAME, gm.ZFIRSTNAME, m.ZCHATSESSION, m.ZSORT, p.ZISFROMME
  FROM ZWAMESSAGE m
  LEFT JOIN ZWAMESSAGE p ON p.Z_PK = m.ZPARENTMESSAGE
  LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
  LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER

  """
let LINE_CHAT = Int32(18)
let LINE_SORT = Int32(19)
let LINE_PARENT_MINE = Int32(20)
let LINE_MEDIA_PATH = Int32(12)

/// A group's own names for its members (its member rows), by person.
typealias MemberNames = [String: (contact: String?, first: String?)]

struct Session {
  let pk: Int64
  let jid: String
  let type: Int
  let unread: Int
  let archived: Bool
  let lastAt: Double
  /// Not removed, hidden or left out (status, channels, broadcasts).
  let shown: Bool
  let key: String
  let name: String

  var kind: String { type == SESSION_DM ? "dm" : type == SESSION_GROUP ? "group" : "community" }
}

/// Everything a request needs besides messages: chats, names and who is who.
final class World {
  var sessions: [Session] = []
  var byKey: [String: Int] = [:]
  var byPk: [Int64: Int] = [:]
  /// "<n>@lid" -> "<n>@s.whatsapp.net" (LID.sqlite, then ContactsV2).
  var lidToUser: [String: String] = [:]
  var contactNames: [String: String] = [:]
  var pushNames: [String: String] = [:]
  /// The key of any id a person has (either id, a 1:1's) -> that person.
  var personByKey: [String: String] = [:]
  /// A person -> their 1:1s (indexes in `sessions`, newest first).
  var dmsByPerson: [String: [Int]] = [:]
  /// Every known number's digits, and its last NUMBER_SUFFIX_DIGITS, -> the person ("<digits>@s.whatsapp.net",
  /// or the @lid of an address-book contact with that number and no WhatsApp id).
  var personByNumber: [String: String] = [:]
  var personBySuffix: [String: String] = [:]
  var ownerDigits: [String] = []

  /// A person's one id: their number's jid when known, else the id itself.
  func person(_ jid: String) -> String { jid.hasSuffix(LID_SUFFIX) ? (lidToUser[jid] ?? jid) : jid }

  func isOwner(_ jid: String) -> Bool { ownerDigits.contains(String(jid.prefix { $0 != "@" })) }

  func addNumber(_ jid: String) {
    guard jid.hasSuffix(USER_SUFFIX) else { return }
    let digits = jid.dropLast(USER_SUFFIX.count)
    guard isAsciiDigits(digits) else { return }
    addNumber(String(digits), of: jid)
  }

  /// A number's digits (and its last ones) name `person`; the first person a number is given keeps it.
  func addNumber(_ digits: String, of person: String) {
    guard (1...PHONE_MAX).contains(digits.count) else { return }
    if personByNumber[digits] == nil { personByNumber[digits] = person }
    let tail = String(digits.suffix(NUMBER_SUFFIX_DIGITS))
    if digits.count >= NUMBER_SUFFIX_DIGITS, personBySuffix[tail] == nil { personBySuffix[tail] = person }
  }

  /// The person a dialled number is: all its digits, else its last ones; nil for a number nobody has.
  func person(number raw: String) -> String? {
    guard raw.unicodeScalars.allSatisfy({ NUMBER_CHARS.contains($0) }) else { return nil }
    let digits = digitsIn(raw)
    if let p = personByNumber[digits] { return p }
    return digits.count >= NUMBER_SUFFIX_DIGITS ? personBySuffix[String(digits.suffix(NUMBER_SUFFIX_DIGITS))] : nil
  }

  /// Every key a person goes by (their 1:1s under either id, either id's
  /// own key), from any one of them; empty for a key that isn't a person's.
  /// Whether a jid is skipped is `Hidden.persons.contains(person(jid))`.
  func personKeys(_ chatKey: String) -> Set<String> {
    guard let p = personByKey[chatKey] else { return [] }
    return Set(personByKey.compactMap { $0.value == p ? $0.key : nil })
  }
}

/// What the skip list hides, for one request: people (by person()) and
/// groups (by jid) its keys name through a chat or a link, and any id whose
/// own key, or its person's, is on it (a skipped 1:1 WhatsApp no longer
/// has). `checked` keeps each id's answer.
final class Hidden {
  var persons = Set<String>()
  var groups = Set<String>()
  let keys: Set<String>
  let key: (String) -> String
  private var checked: [String: Bool] = [:]

  init(keys: Set<String>, key: @escaping (String) -> String) {
    self.keys = keys
    self.key = key
  }

  func hides(_ s: Session, _ w: World) -> Bool { s.type == SESSION_DM ? persons.contains(w.person(s.jid)) : groups.contains(s.jid) }

  /// Whether `id` (a person's WhatsApp id, by number or @lid) is a skipped person's.
  func hides(person id: String, _ w: World) -> Bool {
    if let known = checked[id] { return known }
    let p = w.person(id)
    let hidden = persons.contains(p) || (!keys.isEmpty && (keys.contains(key(id)) || keys.contains(key(p))))
    checked[id] = hidden
    return hidden
  }
}

final class SkipList {
  let path: String
  private(set) var keys = Set<String>()
  private(set) var broken = false
  private var stamp: [Int64] = []

  init(_ state: String) { path = state + "/skip.json" }

  /// Re-read when the file changed (inode, size or mtime); missing is empty.
  func refresh() {
    var st = stat()
    guard lstat(path, &st) == 0 else {
      broken = errno != ENOENT
      if !broken { keys = [] }
      stamp = []
      return
    }
    let now: [Int64] = [Int64(st.st_ino), Int64(st.st_size), Int64(st.st_mtimespec.tv_sec), Int64(st.st_mtimespec.tv_nsec)]
    if now == stamp && !broken { return }
    stamp = now
    guard (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), st.st_size <= SKIP_FILE_MAX,
          let data = FileManager.default.contents(atPath: path),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let version = obj["version"] as? NSNumber, version.intValue == 1, !isBool(version),
          let list = obj["chatKeys"] as? [Any] else {
      broken = true
      return
    }
    var next = Set<String>()
    for k in list {
      guard let s = k as? String, isChatKey(s) else {
        broken = true
        return
      }
      next.insert(s)
    }
    keys = next
    broken = false
  }
}

func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }

// ---------------------------------------------------------------- answers

struct MediaOut: Encodable {
  let kind: String
  let fileName: String?
  let bytes: Int64?
  let durationS: Double?
  let local: Bool
}

struct MessageOut: Encodable {
  let msgKey: String
  let at: String
  let fromMe: Bool
  let sender: String
  let kind: String
  var text: String?
  var caption: String?
  var media: MediaOut?
  var replyTo: String?
  var replyToMe: Bool?
  var mentionsMe: Bool?
  var skippedSender: Bool?
}

struct ChatOut: Encodable {
  let chatKey: String
  let name: String
  let kind: String
  let lastAt: String
  let unread: Int
  let lastFromMe: Bool
  let archived: Bool
  let members: Int?
  let phone: String?
}

struct ChatsOut: Encodable {
  let chats: [ChatOut]
  let total: Int
}

struct ReadOut: Encodable {
  let chat: ChatOut
  let messages: [MessageOut]
  let more: Bool
}

/// `total`: how many chats matched (`ambiguous` holds the newest AMBIGUOUS_MAX).
struct AmbiguousOut: Encodable {
  let ambiguous: [ChatOut]
  let total: Int
}

struct HitOut: Encodable {
  let chatKey: String
  let chatName: String
  let msgKey: String
  let at: String
  let fromMe: Bool
  let sender: String
  let snippet: String
}

struct SearchOut: Encodable { let hits: [HitOut] }

struct CursorOut: Encodable {
  let pk: Int64
  let at: String
}

struct NewChatOut: Encodable {
  let chat: ChatOut
  let messages: [MessageOut]
  let earlier: [MessageOut]
}

struct NewSinceOut: Encodable {
  let chats: [NewChatOut]
  let nextCursor: CursorOut
  let truncated: Bool
  let reset: Bool
}

/// Each chat key asked for and a time, or null (never left out).
struct TimesOut: Encodable {
  let times: [(key: String, at: String?)]

  struct Key: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    for t in times {
      if let at = t.at { try c.encode(at, forKey: Key(stringValue: t.key)) } else { try c.encodeNil(forKey: Key(stringValue: t.key)) }
    }
  }
}

struct MediaFileOut: Encodable {
  let file: String
  let bytes: Int64
  let kind: String
  let mime: String
  let fileName: String?
}

struct CallOut: Encodable {
  let callKey: String
  let at: String
  let who: String
  let chatKey: String?
  let via: String
  let incoming: Bool
  let missed: Bool
  let video: Bool
  let durationS: Double
}

struct CallsOut: Encodable { let calls: [CallOut] }

struct WhatsAppOut: Encodable {
  let found: Bool
  let running: Bool
  let schemaOk: Bool
  let contactsOk: Bool
  let newestAt: String?
  let walMtime: String?

  enum CodingKeys: String, CodingKey { case found, running, schemaOk, contactsOk, newestAt, walMtime }

  // The two times are null, not left out, when unknown.
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(found, forKey: .found)
    try c.encode(running, forKey: .running)
    try c.encode(schemaOk, forKey: .schemaOk)
    try c.encode(contactsOk, forKey: .contactsOk)
    try c.encode(newestAt, forKey: .newestAt)
    try c.encode(walMtime, forKey: .walMtime)
  }
}

struct PhoneOut: Encodable { let readable: Bool }

/// `skipOk`: false while the skip list won't parse (reads answer `busy`; `skipped` counts the last good one).
/// `skipUnmatched`: how many of its keys name no chat or person here (left out until a read built the world).
struct StatusOut: Encodable {
  let whatsapp: WhatsAppOut
  let phone: PhoneOut
  let skipped: Int
  let skipOk: Bool
  let skipUnmatched: Int?
  let version: Int
}

struct AnyEncodable: Encodable {
  let value: any Encodable
  func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

struct OkReply: Encodable {
  let id: Int
  let ok = true
  let data: AnyEncodable
}

struct ErrReply: Encodable {
  let id: Int
  let ok = false
  let error: String
  let detail: String?
}

// ---------------------------------------------------------------- request args

struct Args {
  let raw: [String: Any]

  private func value(_ k: String) -> Any? {
    guard let v = raw[k], !(v is NSNull) else { return nil }
    return v
  }

  func string(_ k: String, max: Int) throws -> String? {
    guard let v = value(k) else { return nil }
    guard let s = v as? String else { throw bad(k) }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, t.count <= max else { throw bad(k) }
    return t
  }

  /// An ISO time as Core Data milliseconds, the unit every time is compared
  /// in (appleMs). Rounded: the parse can land a hair either side of the
  /// millisecond it names.
  func time(_ k: String) throws -> Int64? {
    guard let v = value(k) else { return nil }
    guard let s = v as? String, let d = parseIso(s) else { throw bad(k) }
    return Int64((d.timeIntervalSinceReferenceDate * 1000).rounded())
  }

  func limit(max: Int, def: Int) throws -> Int {
    guard let v = value("limit") else { return def }
    guard let n = v as? NSNumber, !isBool(n), let i = Int(exactly: n.doubleValue), (1...max).contains(i) else { throw bad("limit") }
    return i
  }

  func flag(_ k: String) throws -> Bool {
    guard let v = value(k) else { return false }
    guard let n = v as? NSNumber, isBool(n) else { throw bad(k) }
    return n.boolValue
  }

  func chatKey() throws -> String {
    guard let s = value("chatKey") as? String, isChatKey(s) else { throw bad("chatKey") }
    return s
  }

  /// A time that must be there.
  func at(_ k: String) throws -> Int64 {
    guard let t = try time(k) else { throw bad(k) }
    return t
  }

  func int(_ k: String, _ range: ClosedRange<Int>) throws -> Int {
    guard let n = value(k) as? NSNumber, !isBool(n), let i = Int(exactly: n.doubleValue), range.contains(i) else { throw bad(k) }
    return i
  }

  func chatKeyIfAny() throws -> String? { value("chatKey") == nil ? nil : try chatKey() }

  func chatKeys(_ k: String, max: Int) throws -> [String] {
    guard let list = value(k) as? [Any], list.count <= max else { throw bad(k) }
    return try list.map {
      guard let s = $0 as? String, isChatKey(s) else { throw bad(k) }
      return s
    }
  }

  /// `{pk, at}`, or nil when left out or null; `at` as milliseconds.
  func cursor() throws -> (pk: Int64, atMs: Int64)? {
    guard let v = value("cursor") else { return nil }
    guard let c = v as? [String: Any], let n = c["pk"] as? NSNumber, !isBool(n), let pk = Int64(exactly: n.doubleValue), pk >= 0,
          let at = try? Args(raw: c).at("at") else { throw bad("cursor") }
    return (pk, at)
  }

  /// "<chatKey>.<stanza id>" (or "<chatKey>._<row id>"), split; malformed is bad_request.
  func msgKey() throws -> (chatKey: String, stanza: String) {
    guard let s = value("msgKey") as? String, let dot = s.firstIndex(of: ".") else { throw bad("msgKey") }
    let chat = String(s[..<dot])
    let stanza = String(s[s.index(after: dot)...])
    guard isChatKey(chat), (1...STANZA_MAX).contains(stanza.utf8.count) else { throw bad("msgKey") }
    return (chat, stanza)
  }
}

// ---------------------------------------------------------------- the reader

final class Reader {
  let opts: Options
  let salt: [UInt8]
  let skip: SkipList
  let chat: Source
  let contacts: Source
  let lid: Source
  let calls: Source
  private var world: World?
  private var worldStamp: [Int64] = []
  private var owner: (generation: Int, digits: [String])?
  /// The ChatStorage open (generation) in which an @lid was seen (linksNeeded).
  private var lidsSeen = -1
  private var lastSweep = Date.distantPast

  init(_ opts: Options, salt: [UInt8]) {
    self.opts = opts
    self.salt = salt
    skip = SkipList(opts.state)
    chat = Source(opts.container + "/ChatStorage.sqlite", CHAT_TABLES, required: true)
    contacts = Source(opts.container + "/ContactsV2.sqlite", CONTACT_TABLES, required: false)
    lid = Source(opts.container + "/LID.sqlite", LID_TABLES, required: false)
    calls = Source(opts.container + "/CallHistory.sqlite", WA_CALL_TABLES, required: false)
  }

  var now: Date { opts.now ?? Date() }
  /// `now` in Core Data milliseconds (as Args.time gives a time).
  var nowMs: Int64 { Int64((now.timeIntervalSinceReferenceDate * 1000).rounded()) }

  func key(_ id: String) -> String { hmacKey(salt, id) }
  func callKey(_ id: String) -> String { hmacKey(salt, "call " + id, prefix: UInt8(ascii: "k")) }

  /// Between requests: idle databases closed, a deleted salt written again,
  /// old spool copies deleted (by the real clock, never --now).
  func closeIdle() {
    let t = Date()
    for s in [chat, contacts, lid, calls] { s.closeIfIdle(t) }
    keepSalt()
    if t.timeIntervalSince(lastSweep) > SPOOL_SWEEP_S {
      lastSweep = t
      sweepSpool()
    }
  }

  /// The salt file gone while the reader runs (it, or the state folder,
  /// deleted): written again from memory, so the next start keeps the same
  /// keys. Only into <state> while it is a folder of ours; never over a file.
  func keepSalt() {
    let path = opts.state + "/salt"
    var st = stat()
    guard lstat(path, &st) != 0, errno == ENOENT, lstat(opts.state, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid() else { return }
    if publishSalt(path, salt) { log("the salt was gone: written again") }
  }

  // ---- one request

  func handle(_ line: [UInt8]) -> [UInt8] {
    var id = 0
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    do {
      guard let obj = try? JSONSerialization.jsonObject(with: Data(line)), let req = obj as? [String: Any] else { throw bad("not a JSON object") }
      guard let n = req["id"] as? NSNumber, !isBool(n), let i = Int(exactly: n.doubleValue), i >= 0 else { throw bad("id") }
      id = i
      guard let op = req["op"] as? String else { throw bad("op") }
      let rawArgs = req["args"] ?? [String: Any]()
      guard let args = rawArgs as? [String: Any] else { throw bad("args") }
      deadlineNs = DispatchTime.now().uptimeNanoseconds + (op == "search" ? SEARCH_NS : REQUEST_NS)
      defer { deadlineNs = .max }
      let data = try run(op, Args(raw: args))
      return Array(try encoder.encode(OkReply(id: id, data: AnyEncodable(value: data))))
    } catch {
      let f = error as? Failure ?? Failure("unsupported", "the answer couldn't be written")
      return Array((try? encoder.encode(ErrReply(id: id, error: f.code, detail: f.detail))) ?? Data("{\"id\":\(id),\"ok\":false,\"error\":\"unsupported\"}".utf8))
    }
  }

  func run(_ op: String, _ args: Args) throws -> any Encodable {
    switch op {
    case "status": return try status()
    case "chats":
      return try chats(q: args.string("q", max: NAME_MAX), since: args.time("since"), limit: args.limit(max: CHATS_MAX, def: CHATS_DEFAULT),
                       waiting: args.flag("waiting"))
    case "read":
      let chatKey = try args.chatKey()
      let since = try args.time("since"), before = try args.time("before"), limit = try args.limit(max: READ_MAX, def: READ_DEFAULT)
      let (w, hide) = try load()
      // Unknown and skipped answer alike: a reply never confirms a skipped chat exists.
      guard let i = w.byKey[chatKey], w.sessions[i].shown, !hide.hides(w.sessions[i], w) else { throw Failure("not_found") }
      return try read(w.sessions[i], w, hide, since: since, before: before, limit: limit)
    case "readByName":
      guard let name = try args.string("name", max: NAME_MAX) else { throw bad("name") }
      return try readByName(name, since: args.time("since"), before: args.time("before"), limit: args.limit(max: READ_MAX, def: READ_DEFAULT))
    case "search":
      guard let q = try args.string("q", max: QUERY_MAX) else { throw bad("q") }
      return try search(q, since: args.time("since"), chatKey: args.chatKeyIfAny(), limit: args.limit(max: SEARCH_MAX, def: SEARCH_DEFAULT))
    case "newSince":
      return try newSince(cursor: args.cursor(), guardHours: args.int("guardHours", 1...HOURS_MAX),
                          firstRunHours: args.int("firstRunHours", 1...HOURS_MAX), maxRows: args.int("maxRows", 1...NEW_ROWS_MAX))
    case "lastFromMe": return try lastFromMe(args.chatKeys("chatKeys", max: KEYS_MAX))
    case "media": return try media(args.msgKey(), maxBytes: args.int("maxBytes", 1...MEDIA_MAX_BYTES))
    case "waCalls": return try waCalls(since: args.at("since"))
    case "phoneCalls": return try phoneCalls(since: args.at("since"))
    default: throw bad("unknown op")
    }
  }

  // ---- status

  /// Each of WhatsApp's databases on its own. ChatStorage gives `found`,
  /// `schemaOk` and the times (refused or timing out, the op fails). The
  /// optional two (names, and which @lid is which number) never stop an
  /// answer: a missing column there is `schemaOk: false` too, any other
  /// failure `contactsOk: false`, and reads answer that failure rather than
  /// go on without them (and miss a skipped person's other id); so does one
  /// missing while load() needs it (linksNeeded). With WhatsApp closed
  /// (`busy`) the times are null and reads answer `busy`. `skipUnmatched`:
  /// the skip keys naming no chat or person in the last world built (left
  /// out before the first read).
  func status() throws -> StatusOut {
    skip.refresh()
    var found = false
    var schemaOk = false
    var contactsOk = true
    var newest: String?
    switch fileState(chat.path) {
    case .missing: break
    case .denied: throw Failure("no_access", "macOS refused ChatStorage.sqlite to the reader")
    case .present:
      found = true
      schemaOk = true
      var closed = false
      var chatDb: Database?
      do {
        chatDb = try chat.get()
        if let db = chatDb {
          let s = try db.prepare("SELECT max(ZMESSAGEDATE) FROM ZWAMESSAGE")
          if try s.step(), !s.isNull(0) { newest = isoApple(s.double(0)) }
        }
      } catch let f as Failure where f.code == "unsupported" {
        schemaOk = false
      } catch let f as Failure where f.code == "busy" {
        // Closed: nothing more to say until WhatsApp opens it.
        closed = true
      }
      for source in [contacts, lid] where !closed {
        do {
          if try source.get() == nil, let db = chatDb, (try? linksNeeded(db)) ?? true { contactsOk = false }
        } catch let f as Failure where f.code == "unsupported" {
          schemaOk = false
        } catch {
          contactsOk = false
        }
      }
    }
    return StatusOut(
      whatsapp: WhatsAppOut(found: found, running: whatsAppRunning(), schemaOk: schemaOk, contactsOk: contactsOk, newestAt: newest,
                            walMtime: mtime(chat.path + "-wal")),
      phone: PhoneOut(readable: phoneReadable()),
      skipped: skip.keys.count,
      skipOk: !skip.broken,
      skipUnmatched: world.map { w in skip.keys.filter { w.byKey[$0] == nil && w.personByKey[$0] == nil }.count },
      version: READER_VERSION)
  }

  /// Whether a missing LID.sqlite or ContactsV2.sqlite must stop reads:
  /// something is skipped and WhatsApp names someone by an @lid (a 1:1, a
  /// group member, a call's people), whom only those files link to a
  /// number. Found once per open of ChatStorage when it is so.
  func linksNeeded(_ db: Database) throws -> Bool {
    guard !skip.keys.isEmpty else { return false }
    if lidsSeen == chat.generation { return true }
    let q = try db.prepare("""
      SELECT EXISTS (SELECT 1 FROM ZWAGROUPMEMBER WHERE ZMEMBERJID LIKE '%\(LID_SUFFIX)')
          OR EXISTS (SELECT 1 FROM ZWACHATSESSION WHERE ZCONTACTJID LIKE '%\(LID_SUFFIX)')
      """)
    var seen = try q.step() && q.int(0) == 1
    if !seen, let callsDb = try? calls.get() {
      let c = try callsDb.prepare("SELECT EXISTS (SELECT 1 FROM ZWACDCALLEVENTPARTICIPANT WHERE ZJIDSTRING LIKE '%\(LID_SUFFIX)')")
      seen = try c.step() && c.int(0) == 1
    }
    if seen { lidsSeen = chat.generation }
    return seen
  }

  /// NSWorkspace's list is kept current by the main run loop, so it is read there.
  func whatsAppRunning() -> Bool {
    DispatchQueue.main.sync { NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == WHATSAPP_BUNDLE } }
  }

  /// macOS lets the reader open the iPhone call log (it needs Full Disk
  /// Access); closed for now (`busy`) still counts. Never kept open.
  func phoneReadable() -> Bool {
    guard fileState(opts.phoneDb) == .present else { return false }
    do {
      _ = try Database.open(opts.phoneDb)
      return true
    } catch let f as Failure {
      return f.code == "busy"
    } catch {
      return false
    }
  }

  // ---- the world, rebuilt when any of WhatsApp's databases changed

  func load() throws -> (World, Hidden) {
    skip.refresh()
    if skip.broken { throw Failure("busy", "the skip list can't be read") }
    guard let chatDb = try chat.get() else { throw Failure("no_access") }
    let contactsDb = try contacts.get()
    let lidDb = try lid.get()
    if contactsDb == nil || lidDb == nil, try linksNeeded(chatDb) {
      // As if macOS refused it: without its links a skipped person's @lid would show.
      throw Failure("no_access", "\(((contactsDb == nil ? contacts : lid).path as NSString).lastPathComponent) isn't there, and the skip list needs it")
    }
    let chatV = try chatDb.dataVersion()
    let contactsV = try contactsDb?.dataVersion() ?? -1
    let lidV = try lidDb?.dataVersion() ?? -1
    let stamp: [Int64] = [Int64(chat.generation), chatV, Int64(contacts.generation), contactsV, Int64(lid.generation), lidV]
    let w: World
    if let cached = world, stamp == worldStamp {
      w = cached
    } else {
      w = try buildWorld(chatDb, contactsDb, lidDb)
      world = w
      worldStamp = stamp
    }
    let hide = Hidden(keys: skip.keys, key: self.key)
    for k in skip.keys {
      if let i = w.byKey[k] {
        let s = w.sessions[i]
        if s.type == SESSION_DM { hide.persons.insert(w.person(s.jid)) } else { hide.groups.insert(s.jid) }
      } else if let p = w.personByKey[k] {
        hide.persons.insert(p)
      }
    }
    return (w, hide)
  }

  func buildWorld(_ chatDb: Database, _ contactsDb: Database?, _ lidDb: Database?) throws -> World {
    let w = World()
    if let lidDb {
      let s = try lidDb.prepare("SELECT ZIDENTIFIER, ZPHONENUMBER FROM ZWAZACCOUNT WHERE ZIDENTIFIER IS NOT NULL AND ZPHONENUMBER IS NOT NULL")
      while try s.step() {
        if let l = lidJid(s.text(0)), let u = userJid(s.text(1)) { w.lidToUser[l] = u }
      }
    }
    var named: [(String, String)] = []
    var numbers: [String] = []
    // The address book's own number for a contact, by WhatsApp id (else @lid): after WhatsApp's ids, for the iPhone call log.
    var booked: [(digits: String, id: String)] = []
    if let contactsDb {
      let phone = try contactsDb.missingColumns(CONTACT_PHONE).isEmpty ? "ZPHONENUMBER" : "NULL"
      let s = try contactsDb.prepare("SELECT ZWHATSAPPID, ZLID, ZFULLNAME, \(phone) FROM ZWAADDRESSBOOKCONTACT")
      while try s.step() {
        let u = userJid(s.text(0))
        let l = lidJid(s.text(1))
        if let u, let l, w.lidToUser[l] == nil { w.lidToUser[l] = u }
        if let u { numbers.append(u) }
        if let name = nonEmpty(s.text(2)), let id = u ?? l { named.append((id, name)) }
        if let raw = s.text(3), let id = u ?? l { booked.append((digitsIn(raw), id)) }
      }
    }
    for (id, name) in named where w.contactNames[w.person(id)] == nil { w.contactNames[w.person(id)] = name }

    let p = try chatDb.prepare("SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME WHERE ZJID IS NOT NULL")
    while try p.step() {
      if let jid = p.text(0), let name = nonEmpty(p.text(1)), w.pushNames[w.person(jid)] == nil { w.pushNames[w.person(jid)] = name }
    }

    let s = try chatDb.prepare("""
      SELECT Z_PK, ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE, ZUNREADCOUNT, ZARCHIVED, ZLASTMESSAGEDATE, ZREMOVED, ZHIDDEN
      FROM ZWACHATSESSION
      WHERE ZSESSIONTYPE IN (\(SESSION_DM), \(SESSION_GROUP), \(SESSION_COMMUNITY)) AND ZCONTACTJID IS NOT NULL
      ORDER BY ZLASTMESSAGEDATE DESC
      """)
    while try s.step() {
      guard let jid = s.text(1) else { continue }
      let type = Int(s.int(3))
      let leftOut = LEFT_OUT_SUFFIXES.contains { jid.hasSuffix($0) }
      let shown = !leftOut && s.int(7) != 1 && s.int(8) != 1 && !s.isNull(6)
      let partner = s.text(2)
      let person = w.person(jid)
      let name = type == SESSION_DM
        ? nonEmpty(w.contactNames[person]) ?? nonEmpty(partner) ?? nonEmpty(w.pushNames[person]) ?? UNKNOWN
        : nonEmpty(partner) ?? UNKNOWN
      let session = Session(pk: s.int(0), jid: jid, type: type, unread: max(0, Int(s.int(4))), archived: s.int(5) == 1,
                            lastAt: s.double(6), shown: shown, key: key(jid), name: name)
      w.byKey[session.key] = w.sessions.count
      w.byPk[session.pk] = w.sessions.count
      if type == SESSION_DM && !leftOut {
        w.personByKey[session.key] = person
        w.dmsByPerson[person, default: []].append(w.sessions.count)
        numbers.append(person)
      }
      w.sessions.append(session)
    }
    for (l, u) in w.lidToUser {
      w.personByKey[key(l)] = u
      w.personByKey[key(u)] = u
    }
    for u in numbers + w.lidToUser.values.sorted() { w.addNumber(u) }
    for b in booked { w.addNumber(b.digits, of: w.person(b.id)) }
    w.ownerDigits = try ownerDigits(chatDb)
    return w
  }

  /// The owner's two ids: the member (one by number, one @lid) in the most
  /// groups, ties to the one admin most often. Found once per open.
  func ownerDigits(_ db: Database) throws -> [String] {
    if let owner, owner.generation == chat.generation { return owner.digits }
    var digits: [String] = []
    for suffix in [USER_SUFFIX, LID_SUFFIX] {
      let s = try db.prepare("""
        SELECT ZMEMBERJID FROM ZWAGROUPMEMBER WHERE ZMEMBERJID LIKE ?
        GROUP BY ZMEMBERJID ORDER BY count(DISTINCT ZCHATSESSION) DESC, sum(coalesce(ZISADMIN, 0)) DESC, ZMEMBERJID LIMIT 1
        """).bind("%" + suffix)
      if try s.step(), let jid = s.text(0), jid.hasSuffix(suffix) {
        let d = jid.dropLast(suffix.count)
        if isAsciiDigits(d) { digits.append(String(d)) }
      }
    }
    owner = (chat.generation, digits)
    return digits
  }

  // ---- chats

  func chatOut(_ s: Session, _ w: World, withPhone: Bool) throws -> ChatOut {
    var phone: String?
    if withPhone && s.type == SESSION_DM {
      let p = w.person(s.jid)
      let d = p.dropLast(USER_SUFFIX.count)
      if p.hasSuffix(USER_SUFFIX), d.count <= PHONE_MAX, isAsciiDigits(d) { phone = String(d) }
    }
    let fromMe = try lastFromMe(s)
    let count: Int? = s.type == SESSION_DM ? nil : try members(s, w)
    return ChatOut(chatKey: s.key, name: s.name, kind: s.kind, lastAt: isoApple(s.lastAt), unread: s.unread,
                   lastFromMe: fromMe, archived: s.archived, members: count, phone: phone)
  }

  /// Whether the chat's last line is the owner's. System and deleted lines
  /// don't count (the other side deleting a line doesn't make a chat wait);
  /// a type the reader doesn't know does.
  func lastFromMe(_ s: Session) throws -> Bool {
    guard let db = try chat.get() else { return false }
    let q = try db.prepare("""
      SELECT ZISFROMME FROM ZWAMESSAGE WHERE ZCHATSESSION = ? AND ZMESSAGETYPE NOT IN (\(SILENT_TYPES))
      ORDER BY ZSORT DESC LIMIT 1
      """).bind(s.pk)
    return try q.step() && q.int(0) == 1
  }

  /// A group's people, each counted once (the owner is listed under both ids).
  func members(_ s: Session, _ w: World) throws -> Int {
    guard let db = try chat.get() else { return 0 }
    let q = try db.prepare("SELECT ZMEMBERJID FROM ZWAGROUPMEMBER WHERE ZCHATSESSION = ? AND coalesce(ZISACTIVE, 1) != 0 AND ZMEMBERJID IS NOT NULL")
      .bind(s.pk)
    var people = Set<String>()
    while try q.step() { if let jid = q.text(0) { people.insert(w.person(jid)) } }
    return people.count
  }

  func chats(q: String?, since: Int64?, limit: Int, waiting: Bool) throws -> ChatsOut {
    let (w, hide) = try load()
    let waitingSince = now.addingTimeInterval(-WAITING_S).timeIntervalSinceReferenceDate
    var matched: [Session] = []
    for s in w.sessions where s.shown && !hide.hides(s, w) {
      if let since, appleMs(s.lastAt) < since { continue }
      if let q, s.name.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) == nil { continue }
      if waiting {
        guard s.type == SESSION_DM, s.lastAt >= waitingSince, try !lastFromMe(s) else { continue }
      }
      matched.append(s)
    }
    return ChatsOut(chats: try matched.prefix(limit).map { try chatOut($0, w, withPhone: true) }, total: matched.count)
  }

  // ---- reading a chat

  /// A group's own names for its members (the group's member rows), by person.
  func memberNames(_ s: Session, _ w: World) throws -> MemberNames {
    guard s.type != SESSION_DM, let db = try chat.get() else { return [:] }
    let q = try db.prepare("SELECT ZMEMBERJID, ZCONTACTNAME, ZFIRSTNAME FROM ZWAGROUPMEMBER WHERE ZCHATSESSION = ? AND ZMEMBERJID IS NOT NULL")
      .bind(s.pk)
    var names: MemberNames = [:]
    while try q.step() {
      if let jid = q.text(0) { names[w.person(jid)] = (q.text(1), q.text(2)) }
    }
    return names
  }

  /// How a group line's sender is named: the group's contact name, the
  /// address book, the group's first name, their push name.
  func senderName(_ person: String, contact: String?, first: String?, _ w: World) -> String? {
    nonEmpty(contact) ?? nonEmpty(w.contactNames[person]) ?? nonEmpty(first) ?? nonEmpty(w.pushNames[person])
  }

  /// The text with each mention ("@" and an id's digits, as WhatsApp stores
  /// it) made "@" and that person's name: "@Me", "@[skipped]", "@Unknown"
  /// when nobody has a name for it; and whether it names the owner.
  func mentions(_ text: String, _ w: World, _ hide: Hidden, _ name: (String) -> String?) -> (String, Bool) {
    guard text.contains("@") else { return (text, false) }
    var out = String.UnicodeScalarView()
    var me = false
    let scalars = Array(text.unicodeScalars)
    var i = 0
    while i < scalars.count {
      let c = scalars[i]
      i += 1
      out.append(c)
      guard c == "@" else { continue }
      var digits = ""
      while i < scalars.count, scalars[i].value >= 48, scalars[i].value <= 57 {
        digits.unicodeScalars.append(scalars[i])
        i += 1
      }
      guard (MENTION_DIGITS_MIN...PHONE_MAX).contains(digits.count) else {
        // "@5pm": no mention.
        out.append(contentsOf: digits.unicodeScalars)
        continue
      }
      let who: String
      if w.ownerDigits.contains(digits) {
        me = true
        who = ME
      } else {
        let ids = [digits + LID_SUFFIX, digits + USER_SUFFIX]
        who = ids.contains(where: { hide.hides(person: $0, w) }) ? SKIPPED : ids.map { w.person($0) }.compactMap(name).first ?? UNKNOWN
      }
      out.append(contentsOf: who.unicodeScalars)
    }
    return (String(out), me)
  }

  /// Inside <container>/Message, a regular file.
  func mediaIsLocal(_ rel: String?) -> Bool {
    guard let rel, !rel.isEmpty, !rel.hasPrefix("/"), !rel.split(separator: "/").contains("..") else { return false }
    return fileState(opts.container + "/Message/" + rel) == .present
  }

  /// One page of a chat, oldest first. The next page is asked for with
  /// `before` = the page's first `at`, a millisecond, so a page never ends
  /// inside one: it stops short of every line sharing the first left-out
  /// line's millisecond (they lead the next page), or, when all its lines
  /// share it (a burst, an album), grows past `limit` to hold them all (up
  /// to READ_MAX). Exact while WhatsApp's order (ZSORT) and its times agree;
  /// a line whose time is out of order (a skewed clock) can come twice or,
  /// when it is newer than a later page's cut, be missed.
  func read(_ s: Session, _ w: World, _ hide: Hidden, since: Int64?, before: Int64?, limit: Int) throws -> ReadOut {
    var page = try lines(s, w, hide, since: since, before: before, fromMs: nil, limit: limit + 1)
    var more = page.count > limit
    if more {
      let cut = page[limit].ms
      let kept = page.prefix(limit).filter { $0.ms > cut }
      if kept.isEmpty {
        page = try lines(s, w, hide, since: since, before: before, fromMs: cut, limit: READ_MAX + 1)
        more = page.count > READ_MAX
        if more { page.removeLast(page.count - READ_MAX) } else { more = try olderThan(cut, s, since: since) }
      } else {
        page = kept
      }
    }
    return ReadOut(chat: try chatOut(s, w, withPhone: true), messages: page.reversed().map(\.message), more: more)
  }

  /// Whether the chat has a line before millisecond `ms` (and from `since`).
  func olderThan(_ ms: Int64, _ s: Session, since: Int64?) throws -> Bool {
    guard let db = try chat.get() else { throw Failure("no_access") }
    var sql = "SELECT 1 FROM ZWAMESSAGE WHERE ZCHATSESSION = ? AND ZMESSAGEDATE * 1000 < ?"
    var binds: [Any?] = [s.pk, ms]
    if let since {
      sql += " AND ZMESSAGEDATE * 1000 >= ?"
      binds.append(since)
    }
    return try db.prepare(sql + " LIMIT 1").bindAll(binds).step()
  }

  /// Up to `limit` of a chat's lines, newest first (WhatsApp's order), each
  /// with its millisecond; `fromMs`: only those at or after it; `beforeSort`:
  /// only those before that place in the chat. Every time bound is a
  /// millisecond compared as appleMs cuts it (`ZMESSAGEDATE * 1000`).
  func lines(_ s: Session, _ w: World, _ hide: Hidden, since: Int64?, before: Int64?, fromMs: Int64?, beforeSort: Int64? = nil,
             limit: Int) throws -> [(ms: Int64, message: MessageOut)] {
    guard let db = try chat.get() else { throw Failure("no_access") }
    var sql = LINE_SELECT + "WHERE m.ZCHATSESSION = ?"
    if since != nil { sql += " AND m.ZMESSAGEDATE * 1000 >= ?" }
    if before != nil { sql += " AND m.ZMESSAGEDATE * 1000 < ?" }
    if fromMs != nil { sql += " AND m.ZMESSAGEDATE * 1000 >= ?" }
    if beforeSort != nil { sql += " AND m.ZSORT < ?" }
    sql += " ORDER BY m.ZSORT DESC LIMIT ?"
    var binds: [Any?] = [s.pk]
    if let since { binds.append(since) }
    if let before { binds.append(before) }
    if let fromMs { binds.append(fromMs) }
    if let beforeSort { binds.append(beforeSort) }
    binds.append(limit)
    let q = try db.prepare(sql).bindAll(binds)
    var members: [Int64: MemberNames] = [:]
    var out: [(ms: Int64, message: MessageOut)] = []
    while try q.step() { out.append((appleMs(q.double(3)), try lineOut(q, s, w, hide, &members))) }
    return out
  }

  /// One line of `s` from a LINE_SELECT row, as every answer shows it: a
  /// skipped person's group line is "[skipped]" and nothing more, system
  /// and deleted lines carry no text, mentions are names. `members` holds
  /// each group's member names, read on its first line that may mention someone.
  func lineOut(_ q: Statement, _ s: Session, _ w: World, _ hide: Hidden, _ members: inout [Int64: MemberNames]) throws -> MessageOut {
    let pk = q.int(0)
    let fromMe = q.int(1) == 1
    let type = Int(q.int(2))
    let mk = msgKey(s.key, q.text(4), pk)
    let at = isoApple(q.double(3))
    let raw = q.text(5)

    var sender = ME
    if !fromMe {
      if s.type == SESSION_DM {
        sender = s.name
      } else if let memberJid = q.text(15) {
        let person = w.person(memberJid)
        if hide.hides(person: memberJid, w) {
          return MessageOut(msgKey: mk, at: at, fromMe: false, sender: SKIPPED, kind: "other", skippedSender: true)
        }
        sender = senderName(person, contact: q.text(16), first: q.text(17), w) ?? UNKNOWN
      } else {
        sender = UNKNOWN
      }
    }

    let kind = MESSAGE_KINDS[type] ?? (nonEmpty(raw) != nil ? "text" : "other")
    var m = MessageOut(msgKey: mk, at: at, fromMe: fromMe, sender: sender, kind: kind)
    guard !SILENT_KINDS.contains(kind) else { return m }
    let title = q.isNull(9) ? nil : nonEmpty(q.text(13))
    let captioned = CAPTIONED_KINDS.contains(kind) ? title : nil
    if members[s.pk] == nil, (raw?.contains("@") ?? false) || (captioned?.contains("@") ?? false) { members[s.pk] = try memberNames(s, w) }
    let named = members[s.pk] ?? [:]
    let name = { (p: String) in self.senderName(p, contact: named[p]?.contact, first: named[p]?.first, w) }
    if let raw = nonEmpty(raw) {
      let (text, me) = mentions(raw, w, hide, name)
      m.text = text
      if me { m.mentionsMe = true }
    }
    if let captioned {
      let (caption, me) = mentions(captioned, w, hide, name)
      m.caption = caption
      if me { m.mentionsMe = true }
    }
    if !q.isNull(9) {
      if kind == "contact" { m.caption = nonEmpty(q.text(14)) }
      if MEDIA_KINDS.contains(kind) {
        let bytes = q.int(10)
        let duration = q.double(11)
        m.media = MediaOut(kind: kind, fileName: kind == "document" ? title : nil, bytes: bytes > 0 ? bytes : nil,
                           durationS: duration > 0 ? duration : nil, local: mediaIsLocal(q.text(LINE_MEDIA_PATH)))
      }
    }
    if let parentPk = q.intOrNil(6), let parentChat = q.intOrNil(8) {
      let parent: Session? = parentChat == s.pk ? s : w.byPk[parentChat].map { w.sessions[$0] }
      if let ps = parent, ps.shown, !hide.hides(ps, w) {
        m.replyTo = msgKey(ps.key, q.text(7), parentPk)
        // The morning run reads a reply to the owner as about him, wherever his line is.
        if !fromMe, q.int(LINE_PARENT_MINE) == 1 { m.replyToMe = true }
      }
    }
    return m
  }

  func readByName(_ name: String, since: Int64?, before: Int64?, limit: Int) throws -> any Encodable {
    let (w, hide) = try load()
    let visible = w.sessions.filter { $0.shown && !hide.hides($0, w) }
    let match: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
    var hits = visible.filter { $0.name.compare(name, options: match) == .orderedSame }
    if hits.isEmpty { hits = visible.filter { $0.name.range(of: name, options: match) != nil } }
    guard let first = hits.first else { throw Failure("not_found") }
    if hits.count == 1 { return try read(first, w, hide, since: since, before: before, limit: limit) }
    return AmbiguousOut(ambiguous: try hits.prefix(AMBIGUOUS_MAX).map { try chatOut($0, w, withPhone: false) }, total: hits.count)
  }

  /// A chat the skip list and the left-out rules let through, by key; `not_found` otherwise.
  func visible(_ chatKey: String, _ w: World, _ hide: Hidden) throws -> Session {
    guard let i = w.byKey[chatKey], w.sessions[i].shown, !hide.hides(w.sessions[i], w) else { throw Failure("not_found") }
    return w.sessions[i]
  }

  // ---- search

  /// Lines whose text, caption or file name holds `q` (LIKE, its wildcards
  /// taken literally), newest first, from `since` (SEARCH_BACK_MS without
  /// it). Each hit is checked again on the line as shown: the digits inside
  /// a mention never match, and a skipped person's lines never come.
  func search(_ text: String, since: Int64?, chatKey: String?, limit: Int) throws -> SearchOut {
    let (w, hide) = try load()
    guard let db = try chat.get() else { throw Failure("no_access") }
    let only = try chatKey.map { try visible($0, w, hide) }
    let from = since ?? nowMs - SEARCH_BACK_MS
    let pattern = likeEscaped(text)
    var sql = LINE_SELECT + """
      WHERE m.ZMESSAGEDATE >= ? AND m.ZMESSAGEDATE * 1000 >= ? AND m.ZMESSAGETYPE NOT IN (\(SILENT_TYPES))
        AND (m.ZTEXT LIKE '%' || ? || '%' ESCAPE '\\' OR mi.ZTITLE LIKE '%' || ? || '%' ESCAPE '\\')
      """
    var binds: [Any?] = [indexBound(from), from, pattern, pattern]
    if let only {
      sql += " AND m.ZCHATSESSION = ?"
      binds.append(only.pk)
    }
    let q = try db.prepare(sql + " ORDER BY m.ZMESSAGEDATE DESC").bindAll(binds)
    var members: [Int64: MemberNames] = [:]
    var hits: [HitOut] = []
    while hits.count < limit, try q.step() {
      guard let i = w.byPk[q.int(LINE_CHAT)], w.sessions[i].shown, !hide.hides(w.sessions[i], w) else { continue }
      let s = w.sessions[i]
      let m = try lineOut(q, s, w, hide, &members)
      guard m.skippedSender == nil,
            let cut = [m.text, m.caption, m.media?.fileName].lazy.compactMap({ $0.flatMap { snippet($0, text) } }).first else { continue }
      hits.append(HitOut(chatKey: s.key, chatName: s.name, msgKey: m.msgKey, at: m.at, fromMe: m.fromMe, sender: m.sender, snippet: cut))
    }
    return SearchOut(hits: hits)
  }

  // ---- the morning feed

  /// Lines after `cursor.pk` (WhatsApp's row ids grow as lines arrive) from
  /// the last `guardHours`; with no cursor, or one above the newest row id
  /// (re-linked: `reset`), the last `firstRunHours`. Each chat with new lines
  /// comes with up to EARLIER_MAX lines before the first, newest chat first.
  /// After `maxRows` lines it stops (`truncated`), and `nextCursor` is the
  /// last row it got to; else the newest row id. Its `at` is the newest
  /// line's time up to there.
  func newSince(cursor: (pk: Int64, atMs: Int64)?, guardHours: Int, firstRunHours: Int, maxRows: Int) throws -> NewSinceOut {
    let (w, hide) = try load()
    guard let db = try chat.get() else { throw Failure("no_access") }
    let top = try db.prepare("SELECT max(Z_PK) FROM ZWAMESSAGE")
    let maxPk = try top.step() ? top.int(0) : 0
    let reset = cursor.map { $0.pk > maxPk } ?? false
    let fromPk = reset ? 0 : cursor?.pk ?? 0
    let hours = cursor == nil || reset ? firstRunHours : guardHours
    // After this millisecond: appleMs(date) > afterMs, i.e. date * 1000 >= afterMs + 1.
    let afterMs = nowMs - Int64(hours) * MS_PER_HOUR
    // `+` keeps the row id off the primary key, even for the order (else
    // SQLite walks the whole table in row-id order): the date index bounds
    // the scan, and only that window is sorted.
    let q = try db.prepare(LINE_SELECT + """
      WHERE +m.Z_PK > ? AND +m.Z_PK <= ? AND m.ZMESSAGEDATE >= ? AND m.ZMESSAGEDATE * 1000 >= ?
      ORDER BY +m.Z_PK
      """).bind(fromPk, maxPk, indexBound(afterMs + 1), afterMs + 1)

    struct NewChat {
      let index: Int
      var lines: [(sort: Int64, pk: Int64, ms: Int64, m: MessageOut)]
    }
    var chats: [Int64: NewChat] = [:]
    var members: [Int64: MemberNames] = [:]
    var kept = 0
    var lastPk = fromPk
    var newestMs: Int64?
    var truncated = false
    while try q.step() {
      let pk = q.int(0)
      if let i = w.byPk[q.int(LINE_CHAT)], w.sessions[i].shown, !hide.hides(w.sessions[i], w) {
        if kept == maxRows {
          truncated = true
          break
        }
        let s = w.sessions[i]
        let line = (sort: q.int(LINE_SORT), pk: pk, ms: appleMs(q.double(3)), m: try lineOut(q, s, w, hide, &members))
        chats[s.pk, default: NewChat(index: i, lines: [])].lines.append(line)
        kept += 1
      }
      lastPk = pk
      newestMs = max(newestMs ?? Int64.min, appleMs(q.double(3)))
    }

    var atMs: Int64
    if truncated {
      atMs = max(newestMs ?? Int64.min, reset ? Int64.min : cursor?.atMs ?? Int64.min)
    } else {
      let newest = try db.prepare("SELECT max(ZMESSAGEDATE) FROM ZWAMESSAGE")
      atMs = try newest.step() && !newest.isNull(0) ? appleMs(newest.double(0)) : nowMs
    }
    if atMs == Int64.min { atMs = nowMs }

    var out: [(newest: Int64, index: Int, chat: NewChatOut)] = []
    for c in chats.values {
      let s = w.sessions[c.index]
      let lines = c.lines.sorted { ($0.sort, $0.pk) < ($1.sort, $1.pk) }
      let earlier = try self.lines(s, w, hide, since: nil, before: nil, fromMs: nil, beforeSort: lines[0].sort, limit: EARLIER_MAX)
      out.append((lines.map(\.ms).max() ?? .min, c.index,
                  NewChatOut(chat: try chatOut(s, w, withPhone: true), messages: lines.map(\.m), earlier: earlier.reversed().map(\.message))))
    }
    out.sort { ($0.newest, -$0.index) > ($1.newest, -$1.index) }
    return NewSinceOut(chats: out.map(\.chat), nextCursor: CursorOut(pk: truncated ? lastPk : maxPk, at: isoMs(atMs)), truncated: truncated,
                       reset: reset)
  }

  /// When the owner last wrote to each chat (system and deleted lines
  /// aside). A 1:1's key, under either of the person's ids, counts all their
  /// 1:1s. Unknown, left-out and skipped chats are null alike.
  func lastFromMe(_ keys: [String]) throws -> TimesOut {
    let (w, hide) = try load()
    guard let db = try chat.get() else { throw Failure("no_access") }
    var seen = Set<String>()
    var times: [(key: String, at: String?)] = []
    for k in keys where seen.insert(k).inserted {
      let indexes = w.personByKey[k].map { w.dmsByPerson[$0] ?? [] } ?? w.byKey[k].map { [$0] } ?? []
      var best: Double?
      for s in indexes.map({ w.sessions[$0] }) where s.shown && !hide.hides(s, w) {
        let q = try db.prepare("""
          SELECT ZMESSAGEDATE FROM ZWAMESSAGE WHERE ZCHATSESSION = ? AND ZISFROMME = 1 AND ZMESSAGETYPE NOT IN (\(SILENT_TYPES))
          ORDER BY ZSORT DESC LIMIT 1
          """).bind(s.pk)
        if try q.step(), !q.isNull(0) { best = max(best ?? q.double(0), q.double(0)) }
      }
      times.append((k, best.map(isoApple)))
    }
    return TimesOut(times: times)
  }

  // ---- media

  /// <state>/spool (0700, made if missing).
  func spoolDir() throws -> String {
    let dir = opts.state + "/spool"
    var st = stat()
    if lstat(dir, &st) != 0 {
      guard errno == ENOENT, mkdir(dir, 0o700) == 0 || errno == EEXIST, lstat(dir, &st) == 0 else { throw Failure("busy", "the spool can't be made") }
    }
    guard (st.st_mode & S_IFMT) == S_IFDIR, st.st_uid == getuid(), chmod(dir, 0o700) == 0 else { throw Failure("busy", "the spool isn't a folder of ours") }
    return dir
  }

  /// Deletes spool copies older than SPOOL_TTL_S (the daemon deletes each after use; this catches the rest).
  func sweepSpool() {
    let dir = opts.state + "/spool"
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
    let cutoff = Date().timeIntervalSince1970 - SPOOL_TTL_S
    for name in names {
      var st = stat()
      let path = dir + "/" + name
      if lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, Double(st.st_mtimespec.tv_sec) < cutoff { unlink(path) }
    }
  }

  /// A message's file, copied into the spool (0600): the daemon reads and
  /// deletes it. WhatsApp's own file is only read. `not_found` unless the
  /// line is in a chat shown, not a skipped person's, and its file is here.
  func media(_ key: (chatKey: String, stanza: String), maxBytes: Int) throws -> MediaFileOut {
    let (w, hide) = try load()
    let s = try visible(key.chatKey, w, hide)
    guard let db = try chat.get() else { throw Failure("no_access") }
    // A key without a stanza id names its row ("_" and the row id).
    let rowPk = key.stanza.hasPrefix("_") ? Int64(key.stanza.dropFirst()) : nil
    // `+`: found by its stanza id's index (or row id), never by walking the chat.
    let q = try db.prepare(LINE_SELECT + (rowPk == nil ? "WHERE m.ZSTANZAID = ?" : "WHERE m.Z_PK = ?") + " AND +m.ZCHATSESSION = ? LIMIT 1")
    if let rowPk { q.bind(rowPk, s.pk) } else { q.bind(key.stanza, s.pk) }
    guard try q.step() else { throw Failure("not_found") }
    var members: [Int64: MemberNames] = [:]
    let m = try lineOut(q, s, w, hide, &members)
    guard m.msgKey == "\(key.chatKey).\(key.stanza)", m.skippedSender == nil, let media = m.media, media.local,
          let rel = q.text(LINE_MEDIA_PATH) else { throw Failure("not_found", "no file for this message on this Mac") }

    let src = open(opts.container + "/Message/" + rel, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard src >= 0 else { throw Failure("not_found", "no file for this message on this Mac") }
    defer { close(src) }
    var st = stat()
    guard fstat(src, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { throw Failure("not_found", "no file for this message on this Mac") }
    guard st.st_size <= maxBytes else { throw bad("the file is larger than maxBytes") }

    let dir = try spoolDir()
    lastSweep = Date()
    sweepSpool()
    let ext = (rel as NSString).pathExtension.lowercased()
    let useExt = (1...EXT_MAX).contains(ext.utf8.count) && ext.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 122) })
      ? ext : EXT_BY_KIND[m.kind] ?? "bin"
    let file = "\(dir)/\(randomHex(SPOOL_NAME_BYTES)).\(useExt)"
    let dst = open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard dst >= 0 else { throw Failure("busy", "the spool can't be written") }
    var copied = stat()
    let ok = fcopyfile(src, dst, nil, copyfile_flags_t(COPYFILE_DATA)) == 0 && fchmod(dst, 0o600) == 0 && fstat(dst, &copied) == 0
    close(dst)
    guard ok, copied.st_size <= maxBytes else {
      unlink(file)
      throw ok ? bad("the file is larger than maxBytes") : Failure("busy", "the file can't be copied")
    }
    return MediaFileOut(file: file, bytes: Int64(copied.st_size), kind: m.kind, mime: MIME_BY_EXT[useExt] ?? MIME_DEFAULT, fileName: media.fileName)
  }

  // ---- calls

  /// What the owner calls a person: the address book, their 1:1's name,
  /// their push name, else their number.
  func personName(_ p: String, _ w: World) -> String {
    if let n = nonEmpty(w.contactNames[p]) { return n }
    if let i = w.dmsByPerson[p]?.first, w.sessions[i].name != UNKNOWN { return w.sessions[i].name }
    if let n = nonEmpty(w.pushNames[p]) { return n }
    return p.hasSuffix(USER_SUFFIX) ? formatNumber("+" + p.dropLast(USER_SUFFIX.count)) : UNKNOWN
  }

  /// The person's 1:1 (the newest, when they have one under each id), if it is shown.
  func dmKey(_ p: String, _ w: World, _ hide: Hidden) -> String? {
    (w.dmsByPerson[p] ?? []).lazy.map { w.sessions[$0] }.first { $0.shown && !hide.hides($0, w) }?.key
  }

  /// WhatsApp calls from `since`, oldest first: one per call (its aggregate
  /// row; a redial is another attempt of the same call), at its first time,
  /// as long as its longest attempt. Incoming, missed and video are
  /// WhatsApp's own flags. The other people on it name it: one gives its
  /// 1:1's chat key, several (no group) are listed; a group call is its
  /// group's. A call with a skipped person on it (or starting a group's)
  /// and a skipped group's never come.
  func waCalls(since: Int64) throws -> CallsOut {
    let (w, hide) = try load()
    guard let db = try calls.get() else { return CallsOut(calls: []) }
    // The key is the first attempt's call id: a later redial doesn't change it.
    let q = try db.prepare("""
      SELECT * FROM (
        SELECT a.Z_PK AS pk, a.ZINCOMING, a.ZMISSED, a.ZVIDEO,
               coalesce(a.ZFIRSTDATE, (SELECT min(e.ZDATE) FROM ZWACDCALLEVENT e WHERE e.Z1CALLEVENTS = a.Z_PK)) AS at,
               (SELECT max(e.ZDURATION) FROM ZWACDCALLEVENT e WHERE e.Z1CALLEVENTS = a.Z_PK),
               (SELECT e.ZCALLIDSTRING FROM ZWACDCALLEVENT e WHERE e.Z1CALLEVENTS = a.Z_PK AND e.ZCALLIDSTRING <> ''
                ORDER BY e.ZDATE, e.Z_PK LIMIT 1),
               (SELECT max(e.ZGROUPJIDSTRING) FROM ZWACDCALLEVENT e WHERE e.Z1CALLEVENTS = a.Z_PK),
               (SELECT group_concat(e.ZGROUPCALLCREATORUSERJIDSTRING, ' ') FROM ZWACDCALLEVENT e WHERE e.Z1CALLEVENTS = a.Z_PK),
               (SELECT group_concat(p.ZJIDSTRING, ' ') FROM ZWACDCALLEVENTPARTICIPANT p WHERE p.Z1PARTICIPANTS = a.Z_PK)
        FROM ZWAAGGREGATECALLEVENT a)
      WHERE at * 1000 >= ?
      ORDER BY at DESC, pk DESC LIMIT ?
      """).bind(since, CALLS_MAX)
    var out: [CallOut] = []
    while try q.step() {
      let ids = { (i: Int32) in (q.text(i) ?? "").split(separator: " ").map(String.init) }
      // The owner starts every outgoing call: never hidden by a skipped "Message yourself" chat.
      if ids(8).filter({ !w.isOwner($0) }).contains(where: { hide.hides(person: $0, w) }) { continue }
      let others = ids(9).filter { !w.isOwner($0) }
      // Each person once (either id), by id so `who` reads the same every time.
      let people = Set(others.map { w.person($0) }).sorted()
      let who: String
      var chatKey: String?
      if let group = nonEmpty(q.text(7)) {
        guard let i = w.byKey[key(group)], w.sessions[i].shown, !hide.hides(w.sessions[i], w) else { continue }
        who = w.sessions[i].name
        chatKey = w.sessions[i].key
      } else {
        guard !people.isEmpty, !others.contains(where: { hide.hides(person: $0, w) }) else { continue }
        who = people.map { personName($0, w) }.joined(separator: ", ")
        if people.count == 1 { chatKey = dmKey(people[0], w, hide) }
      }
      let id = nonEmpty(q.text(6)) ?? "call \(q.int(0))"
      out.append(CallOut(callKey: callKey("whatsapp \(id)"), at: isoApple(q.double(4)), who: who, chatKey: chatKey, via: "whatsapp",
                         incoming: q.int(1) == 1, missed: q.int(2) == 1, video: q.int(3) == 1, durationS: max(0, q.double(5))))
    }
    return CallsOut(calls: out.reversed())
  }

  /// The iPhone call log from `since`, oldest first. It needs Full Disk
  /// Access on the reader (`no_access` until then) and is never kept open;
  /// WhatsApp's own store too (names, and who is skipped). A number is
  /// matched to a person through WhatsApp's ids (the address book's, its
  /// numbers, the chats'); `who` is then their name, else the number. Rows
  /// WhatsApp logged (its service provider) are left out: waCalls has those
  /// calls. An address that is a WhatsApp id is matched the same way and
  /// never shown (a person nobody names is "Unknown"); any other address
  /// (a FaceTime call by email) is shown as it is, and no skip can match it.
  func phoneCalls(since: Int64) throws -> CallsOut {
    let (w, hide) = try load()
    switch fileState(opts.phoneDb) {
    case .missing: throw Failure("no_access", "the iPhone call log isn't on this Mac")
    case .denied: throw Failure("no_access", "macOS refused the iPhone call log to the reader")
    case .present: break
    }
    let db: Database
    do {
      db = try Database.open(opts.phoneDb)
    } catch let f as Failure where f.code == "busy" {
      throw Failure("busy", "the iPhone call log is closed for now")
    } catch let f as Failure where f.code == "no_access" {
      // The daemon tells this apart by its words (no Full Disk Access), whatever the file is called.
      throw Failure("no_access", "macOS refused the iPhone call log to the reader")
    }
    let missing = try db.missingColumns(PHONE_TABLES)
    guard missing.isEmpty else { throw Failure("unsupported", "the iPhone call log lacks \(missing.prefix(3).joined(separator: ", "))") }
    let byProvider = try db.missingColumns(PHONE_PROVIDER).isEmpty
    let q = try db.prepare("""
      SELECT ZADDRESS, ZDATE, ZDURATION, ZORIGINATED, ZANSWERED, ZCALLTYPE FROM ZCALLRECORD
      WHERE ZDATE >= ? AND ZDATE * 1000 >= ?\(byProvider ? " AND coalesce(ZSERVICE_PROVIDER, '') NOT LIKE '%whatsapp%'" : "")
      ORDER BY ZDATE DESC LIMIT ?
      """).bind(indexBound(since), since, CALLS_MAX)
    var out: [CallOut] = []
    while try q.step() {
      let raw = q.text(0) ?? ""
      let address = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      let who: String
      var chatKey: String?
      if let id = whatsAppId(address) {
        if id.hasSuffix(GROUP_SUFFIX) {
          guard let i = w.byKey[key(id)], w.sessions[i].shown, !hide.hides(w.sessions[i], w) else { continue }
          who = w.sessions[i].name
          chatKey = w.sessions[i].key
        } else {
          guard id.hasSuffix(USER_SUFFIX) || id.hasSuffix(LID_SUFFIX), !hide.hides(person: id, w) else { continue }
          who = personName(w.person(id), w)
          chatKey = dmKey(w.person(id), w, hide)
        }
      } else {
        let p = w.person(number: address)
        // Its own number's key too: a skipped person whose 1:1 is gone.
        if let p, hide.hides(person: p, w) { continue }
        if let own = userJid(address), hide.hides(person: own, w) { continue }
        who = p.map { personName($0, w) } ?? formatNumber(address)
        chatKey = p.flatMap { dmKey($0, w, hide) }
      }
      let incoming = q.int(3) == 0
      out.append(CallOut(callKey: callKey("phone \(raw) \(appleMs(q.double(1)))"), at: isoApple(q.double(1)), who: who, chatKey: chatKey,
                         via: "phone", incoming: incoming, missed: incoming && q.int(4) == 0, video: Int(q.int(5)) == PHONE_CALL_VIDEO,
                         durationS: max(0, q.double(2))))
    }
    return CallsOut(calls: out.reversed())
  }
}

// ---------------------------------------------------------------- the socket

func socketAddress(_ path: String) -> sockaddr_un {
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  withUnsafeMutableBytes(of: &addr.sun_path) { buf in
    let bytes = Array(path.utf8)
    buf.copyBytes(from: bytes)
    buf[bytes.count] = 0
  }
  return addr
}

func connectTo(_ fd: Int32, _ path: String) -> Bool {
  var addr = socketAddress(path)
  return withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  } == 0
}

final class Server {
  let path: String
  let listener: Int32
  private var buffers: [Int32: [UInt8]] = [:]

  /// Listens on `path`, 0600. A stale socket there is replaced; a live one
  /// (another reader) or anything that isn't a socket is refused.
  init(_ path: String) {
    self.path = path
    var st = stat()
    if lstat(path, &st) == 0 {
      guard (st.st_mode & S_IFMT) == S_IFSOCK else { fatal("--socket names something that isn't a socket") }
      let probe = socket(AF_UNIX, SOCK_STREAM, 0)
      let live = probe >= 0 && connectTo(probe, path)
      if probe >= 0 { close(probe) }
      if live { fatal("another reader is listening on this socket") }
      unlink(path)
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { fatal("no socket") }
    var addr = socketAddress(path)
    let old = umask(0o177)
    let bound = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    umask(old)
    guard bound == 0, chmod(path, 0o600) == 0, listen(fd, LISTEN_BACKLOG) == 0 else { fatal("the socket can't be made") }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    listener = fd
  }

  func run(_ reader: Reader) -> Never {
    var chunk = [UInt8](repeating: 0, count: LINE_MAX)
    while true {
      let clients = Array(buffers.keys)
      var fds = [pollfd(fd: listener, events: Int16(POLLIN), revents: 0)] + clients.map { pollfd(fd: $0, events: Int16(POLLIN), revents: 0) }
      let n = poll(&fds, nfds_t(fds.count), POLL_TICK_MS)
      if n < 0 && errno != EINTR { fatal("poll failed") }
      reader.closeIdle()
      if n <= 0 { continue }
      if fds[0].revents != 0 { acceptAll() }
      for (i, fd) in clients.enumerated() where fds[i + 1].revents != 0 {
        let got = read(fd, &chunk, chunk.count)
        if got <= 0 {
          drop(fd)
          continue
        }
        buffers[fd, default: []].append(contentsOf: chunk[0..<got])
        serve(fd, reader)
      }
    }
  }

  private func acceptAll() {
    while true {
      let fd = accept(listener, nil, nil)
      if fd < 0 { return }
      // Only the owner's own processes: any other uid is closed unanswered.
      var uid: uid_t = 0
      var gid: gid_t = 0
      guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(), buffers.count < CLIENTS_MAX else {
        close(fd)
        continue
      }
      _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
      _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
      var on: Int32 = 1
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
      var tv = timeval(tv_sec: SEND_TIMEOUT_S, tv_usec: 0)
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
      buffers[fd] = []
    }
  }

  private func serve(_ fd: Int32, _ reader: Reader) {
    while let buf = buffers[fd], let nl = buf.firstIndex(of: 10) {
      buffers[fd] = Array(buf[(nl + 1)...])
      guard send(fd, reader.handle(Array(buf[..<nl]))) else { return drop(fd) }
    }
    if let buf = buffers[fd], buf.count > LINE_MAX {
      _ = send(fd, Array("{\"id\":0,\"ok\":false,\"error\":\"bad_request\",\"detail\":\"request too long\"}".utf8))
      drop(fd)
    }
  }

  private func send(_ fd: Int32, _ reply: [UInt8]) -> Bool {
    let line = reply + [10]
    var sent = 0
    while sent < line.count {
      let w = line[sent...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
      if w < 0 && errno == EINTR { continue }
      if w <= 0 { return false }
      sent += w
    }
    return true
  }

  private func drop(_ fd: Int32) {
    buffers[fd] = nil
    close(fd)
  }
}

// ---------------------------------------------------------------- main

signal(SIGPIPE, SIG_IGN)
let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
let reader = Reader(options, salt: loadSalt(options.state))
let server = Server(options.socket)

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let stopSources = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler {
    unlink(options.socket)
    // The server thread may be inside SQLite: no atexit work.
    _exit(0)
  }
  src.resume()
  return src
}

let serverThread = Thread { server.run(reader) }
serverThread.stackSize = 8 << 20
serverThread.start()
log("listening (protocol \(READER_VERSION))")

// The main run loop keeps NSWorkspace's app list current and runs the signal handlers.
let keepAlive = Timer(timeInterval: 86_400, repeats: true) { _ in }
RunLoop.main.add(keepAlive, forMode: .common)
RunLoop.main.run()
