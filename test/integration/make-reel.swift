// A synthetic reel for the real-media check (v08-reel-flow.integration.test.ts,
// JANTAR_REAL_MEDIA=1): 360x640 H.264, 4 seconds at 10 frames a second, two
// coloured scenes, each with its words drawn large in white, and no sound.
// Made with Apple's AVFoundation at check time (no ffmpeg); nothing is read
// from disk. Usage: make-reel <out.mp4>
import AVFoundation
import CoreGraphics
import CoreText
import Foundation

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("usage: make-reel <out.mp4>\n".data(using: .utf8)!)
  exit(2)
}
let outURL = URL(fileURLWithPath: args[1])
try? FileManager.default.removeItem(at: outURL)

let W = 360, H = 640, FPS: Int32 = 10, SECONDS = 4
let scenes: [(String, CGColor)] = [
  ("MANGO LASSI", CGColor(red: 0.85, green: 0.35, blue: 0.10, alpha: 1)),
  ("SERVE COLD", CGColor(red: 0.15, green: 0.35, blue: 0.70, alpha: 1)),
]

let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

func frame(_ i: Int) -> CVPixelBuffer {
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  let buf = pb!
  CVPixelBufferLockBaseAddress(buf, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: W, height: H, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
  let scene = min(scenes.count - 1, i * scenes.count / (Int(FPS) * SECONDS))
  ctx.setFillColor(scenes[scene].1)
  ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 40, nil)
  let words = NSAttributedString(string: scenes[scene].0, attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 1, green: 1, blue: 1, alpha: 1),
  ])
  ctx.textPosition = CGPoint(x: 24, y: H / 2)
  CTLineDraw(CTLineCreateWithAttributedString(words), ctx)
  CVPixelBufferUnlockBaseAddress(buf, [])
  return buf
}

let total = Int(FPS) * SECONDS
var i = 0
while i < total {
  if input.isReadyForMoreMediaData {
    adaptor.append(frame(i), withPresentationTime: CMTime(value: CMTimeValue(i), timescale: FPS))
    i += 1
  } else {
    usleep(2000)
  }
}
input.markAsFinished()
await writer.finishWriting()
if writer.status != .completed {
  print("failed: \(String(describing: writer.error))")
  exit(1)
}
print("wrote \(outURL.path)")
