// jantar-messages-reader: Jantar's WhatsApp reader (0.15 Messages).
//
// The one program that opens WhatsApp for Mac's files, read-only. It runs as
// its own LaunchAgent and answers a fixed set of questions for the daemon on
// a 0600 Unix socket, one JSON object per line (reader-protocol.ts):
//
//   {"id":1,"op":"chats","args":{"limit":30}}
//     -> {"id":1,"ok":true,"data":{…}} | {"id":1,"ok":false,"error":"not_found","detail":"…"}
//
//   status                                      {whatsapp: {found, running, schemaOk, newestAt, walMtime},
//                                                phone: {readable}, skipped, version}
//   chats      {q?, since?, limit, waiting?}    {chats: [chat (+phone)], total}
//   read       {chatKey, since?, before?, limit} {chat, messages (oldest first), more}
//   readByName {name, since?, before?, limit}   a read's answer, or {ambiguous: [chat]}
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
//   random bytes, <state>/salt, 0600) is made once and never replaced.
// - The skip list (<state>/skip.json, the daemon's) is reloaded when it
//   changes, checked on every request. A skipped 1:1 hides that person
//   everywhere: their chats under either id (@lid or number), their lines
//   in groups ("[skipped]") and mentions of them; a skipped group hides the
//   group. A skipped chat is `not_found`. A skip list that won't parse
//   refuses reads (`busy`) rather than read everything.
// - Status, channels, broadcast lists, removed and hidden chats are left out.
//   The chat's unsent-draft and last-message-preview columns are never read.
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
/// type: non-empty text is "text", else "other". 14 is a revoked message.
let MESSAGE_KINDS: [Int: String] = [
  0: "text", 1: "image", 2: "video", 3: "voice", 4: "contact", 5: "location", 6: "system", 7: "link",
  8: "document", 10: "system", 11: "gif", 12: "system", 14: "deleted", 15: "sticker", 19: "system",
  46: "system", 59: "system", 66: "poll", 68: "system", 75: "system",
]
let SYSTEM_TYPES = MESSAGE_KINDS.filter { $0.value == "system" }.map { String($0.key) }.sorted().joined(separator: ", ")
let MEDIA_KINDS: Set<String> = ["image", "video", "voice", "document", "sticker", "gif"]
let CAPTIONED_KINDS: Set<String> = ["image", "video", "gif", "link"]
/// Kinds whose lines carry no text out (a system line may hold ids).
let SILENT_KINDS: Set<String> = ["system", "deleted", "reaction"]

let WHATSAPP_BUNDLE = "net.whatsapp.WhatsApp"
let USER_SUFFIX = "@s.whatsapp.net"
let LID_SUFFIX = "@lid"
let LEFT_OUT_SUFFIXES = ["@broadcast", "@newsletter"]
let ME = "Me"
let UNKNOWN = "Unknown"
let SKIPPED = "[skipped]"

let SALT_BYTES = 32
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

/// Core Data seconds (since 2001-01-01Z) as ISO, cut down to the millisecond:
/// a time read back as `before` then never includes the message it came from.
func isoApple(_ seconds: Double) -> String {
  isoFrac.string(from: Date(timeIntervalSinceReferenceDate: (seconds * 1000).rounded(.down) / 1000))
}

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

/// <state> (0700, made if missing) and its salt: 32 random bytes made once,
/// published with link() so a second reader never replaces the first's.
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
    var fresh = [UInt8](repeating: 0, count: SALT_BYTES)
    arc4random_buf(&fresh, SALT_BYTES)
    let tmp = "\(path).\(getpid()).tmp"
    let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { fatal("the salt can't be made") }
    let wrote = write(fd, fresh, SALT_BYTES)
    let synced = fsync(fd)
    close(fd)
    let linked = wrote == SALT_BYTES && synced == 0 ? link(tmp, path) : -1
    let linkErr = errno
    unlink(tmp)
    guard linked == 0 || linkErr == EEXIST else { fatal("the salt can't be made") }
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

func hmacKey(_ salt: [UInt8], _ id: String) -> String {
  var mac = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
  let data = Array(id.utf8)
  CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), salt, salt.count, data, data.count, &mac)
  var out: [UInt8] = [UInt8(ascii: "c")]
  for b in mac.prefix(KEY_HEX / 2) {
    out.append(HEX[Int(b >> 4)])
    out.append(HEX[Int(b & 0xf)])
  }
  return String(decoding: out, as: UTF8.self)
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

func lidJid(_ raw: String?) -> String? {
  guard let raw, !raw.isEmpty else { return nil }
  if raw.hasSuffix(LID_SUFFIX) { return raw }
  return isAsciiDigits(Substring(raw)) ? raw + LID_SUFFIX : nil
}

func nonEmpty(_ s: String?) -> String? {
  guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
  return s
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
  case SQLITE_BUSY, SQLITE_LOCKED, SQLITE_IOERR: return Failure("busy", what)
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
  var ownerDigits: [String] = []

  /// A person's one id: their number's jid when known, else the id itself.
  func person(_ jid: String) -> String { jid.hasSuffix(LID_SUFFIX) ? (lidToUser[jid] ?? jid) : jid }
}

/// What the skip list hides: people (by person()) and groups (by jid).
struct Hidden {
  var persons = Set<String>()
  var groups = Set<String>()

  func hides(_ s: Session, _ w: World) -> Bool { s.type == SESSION_DM ? persons.contains(w.person(s.jid)) : groups.contains(s.jid) }
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

struct AmbiguousOut: Encodable { let ambiguous: [ChatOut] }

struct WhatsAppOut: Encodable {
  let found: Bool
  let running: Bool
  let schemaOk: Bool
  let newestAt: String?
  let walMtime: String?

  enum CodingKeys: String, CodingKey { case found, running, schemaOk, newestAt, walMtime }

  // The two times are null, not left out, when unknown.
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(found, forKey: .found)
    try c.encode(running, forKey: .running)
    try c.encode(schemaOk, forKey: .schemaOk)
    try c.encode(newestAt, forKey: .newestAt)
    try c.encode(walMtime, forKey: .walMtime)
  }
}

struct PhoneOut: Encodable { let readable: Bool }

struct StatusOut: Encodable {
  let whatsapp: WhatsAppOut
  let phone: PhoneOut
  let skipped: Int
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

  /// An ISO time as Core Data seconds.
  func time(_ k: String) throws -> Double? {
    guard let v = value(k) else { return nil }
    guard let s = v as? String, let d = parseIso(s) else { throw bad(k) }
    return d.timeIntervalSinceReferenceDate
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
}

// ---------------------------------------------------------------- the reader

final class Reader {
  let opts: Options
  let salt: [UInt8]
  let skip: SkipList
  let chat: Source
  let contacts: Source
  let lid: Source
  private var world: World?
  private var worldStamp: [Int64] = []
  private var owner: (generation: Int, digits: [String])?

  init(_ opts: Options, salt: [UInt8]) {
    self.opts = opts
    self.salt = salt
    skip = SkipList(opts.state)
    chat = Source(opts.container + "/ChatStorage.sqlite", CHAT_TABLES, required: true)
    contacts = Source(opts.container + "/ContactsV2.sqlite", CONTACT_TABLES, required: false)
    lid = Source(opts.container + "/LID.sqlite", LID_TABLES, required: false)
  }

  var now: Date { opts.now ?? Date() }

  func key(_ id: String) -> String { hmacKey(salt, id) }

  func closeIdle() {
    let t = Date()
    for s in [chat, contacts, lid] { s.closeIfIdle(t) }
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
      deadlineNs = DispatchTime.now().uptimeNanoseconds + REQUEST_NS
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
    default: throw bad("unknown op")
    }
  }

  // ---- status

  /// `schemaOk` is false only when a column is known to be missing; with
  /// WhatsApp closed (`busy`) the times are null and reads answer `busy`.
  func status() throws -> StatusOut {
    skip.refresh()
    var found = false
    var schemaOk = false
    var newest: String?
    switch fileState(chat.path) {
    case .missing: break
    case .denied: throw Failure("no_access", "macOS refused ChatStorage.sqlite to the reader")
    case .present:
      found = true
      schemaOk = true
      do {
        if let db = try chat.get() {
          let s = try db.prepare("SELECT max(ZMESSAGEDATE) FROM ZWAMESSAGE")
          if try s.step(), !s.isNull(0) { newest = isoApple(s.double(0)) }
        }
        _ = try contacts.get()
        _ = try lid.get()
      } catch let f as Failure where f.code == "unsupported" {
        schemaOk = false
      } catch let f as Failure where f.code == "busy" {
        // Closed: nothing more to say until WhatsApp opens it.
      }
    }
    return StatusOut(
      whatsapp: WhatsAppOut(found: found, running: whatsAppRunning(), schemaOk: schemaOk, newestAt: newest, walMtime: mtime(chat.path + "-wal")),
      phone: PhoneOut(readable: phoneReadable()),
      skipped: skip.keys.count,
      version: READER_VERSION)
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
    var hide = Hidden()
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
    if let contactsDb {
      let s = try contactsDb.prepare("SELECT ZWHATSAPPID, ZLID, ZFULLNAME FROM ZWAADDRESSBOOKCONTACT")
      while try s.step() {
        let u = userJid(s.text(0))
        let l = lidJid(s.text(1))
        if let u, let l, w.lidToUser[l] == nil { w.lidToUser[l] = u }
        if let name = nonEmpty(s.text(2)), let id = u ?? l { named.append((id, name)) }
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
      w.sessions.append(session)
      if type == SESSION_DM && !leftOut { w.personByKey[session.key] = person }
    }
    for (l, u) in w.lidToUser {
      w.personByKey[key(l)] = u
      w.personByKey[key(u)] = u
    }
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

  /// Whether the chat's last line (system lines aside) is the owner's.
  func lastFromMe(_ s: Session) throws -> Bool {
    guard let db = try chat.get() else { return false }
    let q = try db.prepare("""
      SELECT ZISFROMME FROM ZWAMESSAGE WHERE ZCHATSESSION = ? AND ZMESSAGETYPE NOT IN (\(SYSTEM_TYPES))
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

  func chats(q: String?, since: Double?, limit: Int, waiting: Bool) throws -> ChatsOut {
    let (w, hide) = try load()
    let waitingSince = now.addingTimeInterval(-WAITING_S).timeIntervalSinceReferenceDate
    var matched: [Session] = []
    for s in w.sessions where s.shown && !hide.hides(s, w) {
      if let since, s.lastAt < since { continue }
      if let q, s.name.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) == nil { continue }
      if waiting {
        guard s.type == SESSION_DM, s.lastAt >= waitingSince, try !lastFromMe(s) else { continue }
      }
      matched.append(s)
    }
    return ChatsOut(chats: try matched.prefix(limit).map { try chatOut($0, w, withPhone: true) }, total: matched.count)
  }

  // ---- reading a chat

  /// The text with a skipped person's "@<number>" made "@[skipped]", and whether it names the owner.
  func mentions(_ text: String, _ w: World, _ hide: Hidden) -> (String, Bool) {
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
      if digits.isEmpty { continue }
      if w.ownerDigits.contains(digits) { me = true }
      let skipped = hide.persons.contains(w.person(digits + USER_SUFFIX)) || hide.persons.contains(w.person(digits + LID_SUFFIX))
      out.append(contentsOf: (skipped ? SKIPPED : digits).unicodeScalars)
    }
    return (String(out), me)
  }

  /// Inside <container>/Message, a regular file.
  func mediaIsLocal(_ rel: String?) -> Bool {
    guard let rel, !rel.isEmpty, !rel.hasPrefix("/"), !rel.split(separator: "/").contains("..") else { return false }
    return fileState(opts.container + "/Message/" + rel) == .present
  }

  func read(_ s: Session, _ w: World, _ hide: Hidden, since: Double?, before: Double?, limit: Int) throws -> ReadOut {
    guard let db = try chat.get() else { throw Failure("no_access") }
    var sql = """
      SELECT m.Z_PK, m.ZISFROMME, m.ZMESSAGETYPE, m.ZMESSAGEDATE, m.ZSTANZAID, m.ZTEXT,
             p.Z_PK, p.ZSTANZAID, p.ZCHATSESSION,
             mi.Z_PK, mi.ZFILESIZE, mi.ZMOVIEDURATION, mi.ZMEDIALOCALPATH, mi.ZTITLE, mi.ZVCARDNAME,
             gm.ZMEMBERJID, gm.ZCONTACTNAME, gm.ZFIRSTNAME
      FROM ZWAMESSAGE m
      LEFT JOIN ZWAMESSAGE p ON p.Z_PK = m.ZPARENTMESSAGE
      LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
      LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
      WHERE m.ZCHATSESSION = ?
      """
    if since != nil { sql += " AND m.ZMESSAGEDATE >= ?" }
    if before != nil { sql += " AND m.ZMESSAGEDATE < ?" }
    sql += " ORDER BY m.ZSORT DESC LIMIT ?"
    var binds: [Any?] = [s.pk]
    if let since { binds.append(since) }
    if let before { binds.append(before) }
    binds.append(limit + 1)
    let q = try db.prepare(sql).bindAll(binds)

    var out: [MessageOut] = []
    while try q.step() {
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
          if hide.persons.contains(person) {
            out.append(MessageOut(msgKey: mk, at: at, fromMe: false, sender: SKIPPED, kind: "other", skippedSender: true))
            continue
          }
          sender = nonEmpty(q.text(16)) ?? nonEmpty(w.contactNames[person]) ?? nonEmpty(q.text(17)) ?? nonEmpty(w.pushNames[person]) ?? UNKNOWN
        } else {
          sender = UNKNOWN
        }
      }

      let kind = MESSAGE_KINDS[type] ?? (nonEmpty(raw) != nil ? "text" : "other")
      var m = MessageOut(msgKey: mk, at: at, fromMe: fromMe, sender: sender, kind: kind)
      if !SILENT_KINDS.contains(kind) {
        if let raw = nonEmpty(raw) {
          let (text, me) = mentions(raw, w, hide)
          m.text = text
          if me { m.mentionsMe = true }
        }
        if !q.isNull(9) {
          let title = nonEmpty(q.text(13))
          if CAPTIONED_KINDS.contains(kind) { m.caption = title }
          if kind == "contact" { m.caption = nonEmpty(q.text(14)) }
          if MEDIA_KINDS.contains(kind) {
            let bytes = q.int(10)
            let duration = q.double(11)
            m.media = MediaOut(kind: kind, fileName: kind == "document" ? title : nil, bytes: bytes > 0 ? bytes : nil,
                               durationS: duration > 0 ? duration : nil, local: mediaIsLocal(q.text(12)))
          }
        }
        if let parentPk = q.intOrNil(6), let parentChat = q.intOrNil(8) {
          let parent: Session? = parentChat == s.pk ? s : w.byPk[parentChat].map { w.sessions[$0] }
          if let ps = parent, ps.shown, !hide.hides(ps, w) { m.replyTo = msgKey(ps.key, q.text(7), parentPk) }
        }
      }
      out.append(m)
    }
    let more = out.count > limit
    if more { out.removeLast() }
    return ReadOut(chat: try chatOut(s, w, withPhone: true), messages: Array(out.reversed()), more: more)
  }

  func readByName(_ name: String, since: Double?, before: Double?, limit: Int) throws -> any Encodable {
    let (w, hide) = try load()
    let visible = w.sessions.filter { $0.shown && !hide.hides($0, w) }
    let match: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
    var hits = visible.filter { $0.name.compare(name, options: match) == .orderedSame }
    if hits.isEmpty { hits = visible.filter { $0.name.range(of: name, options: match) != nil } }
    guard let first = hits.first else { throw Failure("not_found") }
    if hits.count == 1 { return try read(first, w, hide, since: since, before: before, limit: limit) }
    return AmbiguousOut(ambiguous: try hits.prefix(AMBIGUOUS_MAX).map { try chatOut($0, w, withPhone: false) })
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
