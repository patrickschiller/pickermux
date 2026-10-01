import AppKit
import Foundation

// The menu-bar mark uses native vector paths so small template representations
// keep smooth edges and a transparent background in either macOS appearance.
func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}
guard CommandLine.arguments.count == 2 else {
  fail("Provide the output PNG path.")
}
let output = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
guard output.pathExtension == "png",
      let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bitmapFormat: [],
        bytesPerRow: 4096, bitsPerPixel: 32),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fail("Could not create the template image.")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.clear(CGRect(x: 0, y: 0, width: 1024, height: 1024))
NSColor.white.setStroke()
NSColor.white.setFill()

func route(_ y: CGFloat) {
  let path = NSBezierPath()
  path.lineWidth = 92
  path.lineCapStyle = .round
  path.lineJoinStyle = .round
  path.move(to: NSPoint(x: 128, y: y))
  if y == 512 {
    path.line(to: NSPoint(x: 896, y: 512))
  } else {
    path.line(to: NSPoint(x: 288, y: y))
    path.curve(to: NSPoint(x: 736, y: 512),
      controlPoint1: NSPoint(x: 496, y: y),
      controlPoint2: NSPoint(x: 528, y: 512))
    path.line(to: NSPoint(x: 896, y: 512))
  }
  path.stroke()
  NSBezierPath(ovalIn: NSRect(x: 48, y: y - 80, width: 160, height: 160)).fill()
}
route(800)
route(512)
route(224)
NSBezierPath(ovalIn: NSRect(x: 808, y: 424, width: 176, height: 176)).fill()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
  fail("Could not encode the template image.")
}
try png.write(to: output, options: .atomic)
