// jantar-media: Jantar's media helper for Intel reads (spec 5.1).
//
// Built once on the Mac by the daemon (swiftc -O, its own module cache) and
// run only under sandbox-exec with jantar-media.sb: no network, no exec, no
// reads of HOME outside the job dir, writes only in the job dir. Every input
// must be a regular local file inside the job dir (HOME is set to it); the
// helper is never given a URL, so AVFoundation, Speech and PDFKit never
// fetch anything themselves. Each subcommand prints one JSON line.
//
//   probe   <file>                                   {"duration","size","video","audio"}
//   frames  <file> <outdir> <n> <edge>               {"frames":[{"file":"frame-00.jpg","at":1.5},…]}
//   image   <in> <out.jpg> <edge>                    {"w","h"}
//   ocr     <jpg>…                                   {"results":[{"file","lines":[…]}]}
//   speech  <file> <locale> <maxSec>                 {"segments":[{"at","text"}],"cut":false} | {"error":…}
//   pdf     <file> <out.jpg> <edge> <pages> <chars>  {"text","title"?,"author"?,"pages","image"}
//   locales                                          {"locales":[{"id","onDevice"}]}
//
// Speech is on device only (requiresOnDeviceRecognition); it never asks for
// permission, and stops itself once an utterance starts past maxSec.

import AVFoundation
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import PDFKit
import Speech
import UniformTypeIdentifiers
import Vision

// ---------------------------------------------------------------- output

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8) {
    print(s)
  } else {
    print("{\"error\":\"failed\"}")
  }
  fflush(stdout)
}

func fail(_ code: String) -> Never {
  emit(["error": code])
  exit(1)
}

// ---------------------------------------------------------------- paths

func realPath(_ p: String) -> String? {
  guard let r = realpath(p, nil) else { return nil }
  defer { free(r) }
  return String(cString: r)
}

let jobDir: String = {
  guard let home = ProcessInfo.processInfo.environment["HOME"], let real = realPath(home) else { fail("failed") }
  return real
}()

/// A regular file (not a symlink) inside the job dir, by its real path.
func inputFile(_ p: String) -> String {
  var st = stat()
  guard lstat(p, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, let real = realPath(p), real.hasPrefix(jobDir + "/") else { fail("failed") }
  return real
}

/// A path to write inside the job dir (its folder must already be there).
func outputPath(_ p: String) -> String {
  let url = URL(fileURLWithPath: p)
  guard let dir = realPath(url.deletingLastPathComponent().path), dir == jobDir || dir.hasPrefix(jobDir + "/") else { fail("failed") }
  return dir + "/" + url.lastPathComponent
}

func outputDir(_ p: String) -> String {
  guard let dir = realPath(p), dir == jobDir || dir.hasPrefix(jobDir + "/") else { fail("failed") }
  return dir
}

// ---------------------------------------------------------------- images

func writeJpeg(_ img: CGImage, _ path: String) -> Bool {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let dest = CGImageDestinationCreateWithURL(url, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
  CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
  return CGImageDestinationFinalize(dest)
}

/// A 16x16 grey thumbnail's bytes, for the near-duplicate check.
func greyPrint(_ img: CGImage) -> [UInt8]? {
  var px = [UInt8](repeating: 0, count: 16 * 16)
  let ok = px.withUnsafeMutableBytes { buf -> Bool in
    guard let ctx = CGContext(data: buf.baseAddress, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 16,
                              space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
    ctx.interpolationQuality = .low
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: 16, height: 16))
    return true
  }
  return ok ? px : nil
}

/// Mean absolute difference, 0...1.
func greyDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
  var sum = 0
  for i in 0..<min(a.count, b.count) { sum += abs(Int(a[i]) - Int(b[i])) }
  return Double(sum) / Double(max(1, a.count) * 255)
}

// ---------------------------------------------------------------- subcommands

func probe(_ args: [String]) async {
  guard args.count == 1 else { fail("failed") }
  let path = inputFile(args[0])
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  do {
    let duration = try await asset.load(.duration).seconds
    let v = try await asset.loadTracks(withMediaType: .video).count
    let a = try await asset.loadTracks(withMediaType: .audio).count
    let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.intValue ?? 0
    emit(["duration": duration.isFinite ? duration : 0, "size": size, "video": v, "audio": a])
  } catch {
    fail("unreadable")
  }
}

func frames(_ args: [String]) async {
  guard args.count == 4, let n = Int(args[2]), let edge = Int(args[3]), n >= 1, n <= 20, edge >= 64, edge <= 2048 else { fail("failed") }
  let path = inputFile(args[0])
  let out = outputDir(args[1])
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  guard let duration = try? await asset.load(.duration).seconds, duration.isFinite, duration > 0 else { fail("unreadable") }
  let gen = AVAssetImageGenerator(asset: asset)
  gen.appliesPreferredTrackTransform = true
  gen.maximumSize = CGSize(width: edge, height: edge)
  gen.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
  gen.requestedTimeToleranceAfter = CMTime(seconds: 0.5, preferredTimescale: 600)
  var kept: [[String: Any]] = []
  var last: [UInt8]? = nil
  for k in 0..<n {
    let t = duration * (Double(k) + 0.5) / Double(n)
    guard let (img, actual) = try? await gen.image(at: CMTime(seconds: t, preferredTimescale: 600)) else { continue }
    let print16 = greyPrint(img)
    if let a = print16, let b = last, greyDiff(a, b) < 0.04 { continue }
    let name = String(format: "frame-%02d.jpg", k)
    guard writeJpeg(img, out + "/" + name) else { continue }
    last = print16
    let at = actual.seconds.isFinite ? max(0, actual.seconds) : t
    kept.append(["file": name, "at": at])
  }
  emit(["frames": kept])
}

func image(_ args: [String]) {
  guard args.count == 3, let edge = Int(args[2]), edge >= 32, edge <= 2048 else { fail("failed") }
  let path = inputFile(args[0])
  let out = outputPath(args[1])
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { fail("unreadable") }
  let opts: [CFString: Any] = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceThumbnailMaxPixelSize: edge,
    kCGImageSourceShouldCacheImmediately: true,
  ]
  guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { fail("unreadable") }
  guard writeJpeg(img, out) else { fail("failed") }
  emit(["w": img.width, "h": img.height])
}

func ocr(_ args: [String]) {
  guard !args.isEmpty, args.count <= 20 else { fail("failed") }
  var results: [[String: Any]] = []
  for a in args {
    let path = inputFile(a)
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    try? VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:]).perform([req])
    let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first }.filter { $0.confidence >= 0.5 }.map { String($0.string.prefix(500)) }
    results.append(["file": (path as NSString).lastPathComponent, "lines": Array(lines.prefix(200))])
  }
  emit(["results": results])
}

func speech(_ args: [String]) async {
  guard args.count == 3, let maxSec = Double(args[2]), maxSec > 0 else { fail("failed") }
  let path = inputFile(args[0])
  let status = SFSpeechRecognizer.authorizationStatus()
  if status == .denied || status == .restricted { emit(["error": "denied"]); exit(0) }
  guard let rec = SFSpeechRecognizer(locale: Locale(identifier: args[1])), rec.supportsOnDeviceRecognition else {
    emit(["error": "noModel"]); exit(0)
  }
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  if let audio = try? await asset.loadTracks(withMediaType: .audio), audio.isEmpty { emit(["error": "noAudio"]); exit(0) }
  let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
  req.requiresOnDeviceRecognition = true
  req.shouldReportPartialResults = true
  req.addsPunctuation = true
  req.taskHint = .dictation
  var done = false
  var cut = false
  var errorCode: String? = nil
  var segments: [[String: Any]] = []
  var lastText = ""
  var task: SFSpeechRecognitionTask? = nil
  task = rec.recognitionTask(with: req) { result, error in
    if done { return }
    if let r = result {
      let t = r.bestTranscription
      let text = t.formattedString
      if r.speechRecognitionMetadata != nil || r.isFinal, !text.isEmpty, text != lastText {
        let at = t.segments.first?.timestamp ?? 0
        if at > maxSec {
          cut = true
          done = true
          task?.cancel()
          return
        }
        lastText = text
        segments.append(["at": at, "text": String(text.prefix(20000))])
      }
      if r.isFinal { done = true; return }
    }
    if let e = error as NSError? {
      if segments.isEmpty {
        if e.domain == "kAFAssistantErrorDomain" && e.code == 1110 { errorCode = "noSpeech" }
        else if e.domain == AVFoundationErrorDomain && e.code == -11800 { errorCode = "unreadable" }
        else if e.domain == AVFoundationErrorDomain && e.code == -11828 { errorCode = "format" }
        else if e.domain == "kLSRErrorDomain" || e.domain == "kAFAssistantErrorDomain" { errorCode = "denied" }
        else { errorCode = "failed" }
      }
      done = true
    }
  }
  let deadline = Date().addingTimeInterval(8 * 60)
  while !done && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
  if !done { task?.cancel(); cut = true }
  if let code = errorCode { emit(["error": code]); exit(0) }
  emit(["segments": segments, "cut": cut])
}

func pdf(_ args: [String]) {
  guard args.count == 5, let edge = Double(args[2]), let pages = Int(args[3]), let chars = Int(args[4]), edge >= 64, pages >= 1, chars >= 0 else { fail("failed") }
  let path = inputFile(args[0])
  let out = outputPath(args[1])
  guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { fail("unreadable") }
  var text = ""
  for i in 0..<min(pages, doc.pageCount) {
    guard text.count < chars, let page = doc.page(at: i) else { break }
    if let s = page.string { text += s + "\n" }
  }
  if text.count > chars { text = String(text.prefix(chars)) }
  var obj: [String: Any] = ["text": text, "pages": doc.pageCount, "image": false]
  if let attrs = doc.documentAttributes {
    if let t = attrs[PDFDocumentAttribute.titleAttribute] as? String, !t.isEmpty { obj["title"] = String(t.prefix(2000)) }
    if let a = attrs[PDFDocumentAttribute.authorAttribute] as? String, !a.isEmpty { obj["author"] = String(a.prefix(2000)) }
  }
  if let page = doc.page(at: 0) {
    let box = page.bounds(for: .mediaBox)
    let s = edge / max(1, max(box.width, box.height))
    let img = page.thumbnail(of: NSSize(width: box.width * s, height: box.height * s), for: .mediaBox)
    if let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil), writeJpeg(cg, out) { obj["image"] = true }
  }
  emit(obj)
}

func locales() {
  var out: [[String: Any]] = []
  for l in SFSpeechRecognizer.supportedLocales().sorted(by: { $0.identifier < $1.identifier }) {
    let on = SFSpeechRecognizer(locale: l)?.supportsOnDeviceRecognition ?? false
    out.append(["id": l.identifier.replacingOccurrences(of: "_", with: "-"), "onDevice": on])
  }
  emit(["locales": out])
}

// ---------------------------------------------------------------- main

let argv = Array(CommandLine.arguments.dropFirst())
guard let sub = argv.first else { fail("failed") }
let rest = Array(argv.dropFirst())
switch sub {
case "probe": await probe(rest)
case "frames": await frames(rest)
case "image": image(rest)
case "ocr": ocr(rest)
case "speech": await speech(rest)
case "pdf": pdf(rest)
case "locales": locales()
default: fail("failed")
}
exit(0)
