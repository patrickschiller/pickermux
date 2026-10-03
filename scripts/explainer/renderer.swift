import AppKit
import CoreGraphics
import ImageIO

// Self-contained vector explainer. No capture of the user's screen or state.
let width = 1280
let height = 720
let fps = 30
let duration = 36.0
let palette: [String: String] = [
  "bg": "0B1120", "card": "151F32", "stroke": "2A3951",
  "white": "F3F7FE", "muted": "A8B8CF", "dim": "71829E",
  "mint": "72EDD2", "blue": "8EBEFF", "violet": "B5A3FF"
]
func color(_ key: String, _ alpha: Double = 1) -> NSColor {
  let s = palette[key] ?? key
  let n = UInt32(s, radix: 16)!
  return NSColor(srgbRed: Double((n >> 16) & 255) / 255, green: Double((n >> 8) & 255) / 255, blue: Double(n & 255) / 255, alpha: alpha)
}
func clamp(_ x: Double) -> Double { max(0, min(1, x)) }
func ease(_ x: Double) -> Double { let v = clamp(x); return v * v * (3 - 2 * v) }
func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }
var fontCache: [String: NSFont] = [:]
func font(_ size: Double, _ weight: NSFont.Weight = .regular, _ mono: Bool = false) -> NSFont {
  let key = "\(size):\(weight.rawValue):\(mono)"
  if let f = fontCache[key] { return f }
  let f = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
  fontCache[key] = f
  return f
}
func text(_ value: String, _ x: Double, _ y: Double, _ size: Double, _ key: String = "white", _ weight: NSFont.Weight = .regular, _ w: Double = 1160, _ align: NSTextAlignment = .left, _ mono: Bool = false) {
  let style = NSMutableParagraphStyle()
  style.alignment = align
  style.lineSpacing = 4
  let attributes: [NSAttributedString.Key: Any] = [.font: font(size, weight, mono), .foregroundColor: color(key), .paragraphStyle: style]
  NSAttributedString(string: value, attributes: attributes).draw(in: rect(x, y, w, size * 3.3))
}
func box(_ ctx: CGContext, _ r: CGRect, _ radius: Double = 22, _ fill: String = "card", _ stroke: String? = "stroke", _ alpha: Double = 1) {
  let p = CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
  ctx.setFillColor(color(fill, alpha).cgColor)
  ctx.addPath(p); ctx.fillPath()
  if let stroke = stroke {
    ctx.setStrokeColor(color(stroke, alpha).cgColor); ctx.setLineWidth(1.5)
    ctx.addPath(p); ctx.strokePath()
  }
}
func circle(_ ctx: CGContext, _ x: Double, _ y: Double, _ radius: Double, _ key: String, _ alpha: Double = 1) {
  ctx.setFillColor(color(key, alpha).cgColor); ctx.fillEllipse(in: rect(x - radius, y - radius, radius * 2, radius * 2))
}
func line(_ ctx: CGContext, _ points: [CGPoint], _ key: String, _ lineWidth: Double = 3, _ alpha: Double = 1, _ dashed: Bool = false) {
  guard points.count > 1 else { return }
  ctx.setStrokeColor(color(key, alpha).cgColor); ctx.setLineWidth(lineWidth); ctx.setLineCap(.round); ctx.setLineJoin(.round)
  ctx.setLineDash(phase: 0, lengths: dashed ? [7, 8] : [])
  ctx.beginPath(); ctx.move(to: points[0]); for p in points.dropFirst() { ctx.addLine(to: p) }; ctx.strokePath()
  ctx.setLineDash(phase: 0, lengths: [])
}
func arrow(_ ctx: CGContext, _ points: [CGPoint], _ key: String, _ alpha: Double = 1) {
  line(ctx, points, key, 3, alpha)
  let last = points[points.count - 1], prev = points[points.count - 2]
  let a = atan2(last.y - prev.y, last.x - prev.x)
  let p1 = CGPoint(x: last.x - 10 * cos(a - 0.55), y: last.y - 10 * sin(a - 0.55))
  let p2 = CGPoint(x: last.x - 10 * cos(a + 0.55), y: last.y - 10 * sin(a + 0.55))
  line(ctx, [p1, last, p2], key, 3, alpha)
}
func travel(_ ctx: CGContext, _ points: [CGPoint], _ p: Double, _ key: String) {
  let spans = zip(points, points.dropFirst()).map { hypot($1.x - $0.x, $1.y - $0.y) }
  let total = spans.reduce(0, +)
  var remaining = total * clamp(p)
  for i in spans.indices {
    if remaining <= spans[i] || i == spans.count - 1 {
      let f = clamp(remaining / spans[i]); let a = points[i], b = points[i+1]
      let x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f
      circle(ctx, x, y, 18, key, 0.10); circle(ctx, x, y, 10, key, 0.18); circle(ctx, x, y, 5.5, key)
      return
    }
    remaining -= spans[i]
  }
}
func pill(_ ctx: CGContext, _ value: String, _ x: Double, _ y: Double, _ w: Double, _ key: String = "mint") {
  box(ctx, rect(x, y, w, 42), 21, key, nil, 0.11)
  text(value, x + 12, y + 9, 17, key, .medium, w - 24, .center)
}
func mark(_ ctx: CGContext, _ x: Double, _ y: Double, _ s: Double = 1, _ key: String = "mint") {
  line(ctx, [CGPoint(x:x, y:y), CGPoint(x:x+12*s,y:y),CGPoint(x:x+27*s,y:y-12*s)], key, 2.7*s)
  line(ctx, [CGPoint(x:x+12*s,y:y),CGPoint(x:x+27*s,y:y+12*s)], key, 2.7*s)
  circle(ctx,x,y,4*s,key);circle(ctx,x+27*s,y-12*s,4*s,key);circle(ctx,x+27*s,y+12*s,4*s,key)
}
func codexIcon(_ ctx: CGContext, _ x: Double, _ y: Double, _ key: String = "blue") {
  line(ctx,[CGPoint(x:x+11,y:y),CGPoint(x:x,y:y+11),CGPoint(x:x+11,y:y+22)],key,3)
  line(ctx,[CGPoint(x:x+29,y:y),CGPoint(x:x+40,y:y+11),CGPoint(x:x+29,y:y+22)],key,3)
}
func chipIcon(_ ctx: CGContext, _ x: Double, _ y: Double, _ key: String = "mint") {
  box(ctx,rect(x+5,y+3,30,30),7,"card",key)
  box(ctx,rect(x+13,y+11,14,14),3,key,nil,0.8)
  for i in 0..<3 { let d=Double(i)*9+11; line(ctx,[CGPoint(x:x+d,y:y-2),CGPoint(x:x+d,y:y+3)],key,2);line(ctx,[CGPoint(x:x+d,y:y+33),CGPoint(x:x+d,y:y+38)],key,2) }
}
func globe(_ ctx: CGContext, _ x: Double, _ y: Double, _ key: String = "violet") {
  ctx.setStrokeColor(color(key).cgColor);ctx.setLineWidth(2.5);ctx.strokeEllipse(in:rect(x,y,38,38));ctx.strokeEllipse(in:rect(x+10,y,18,38))
  line(ctx,[CGPoint(x:x,y:y+19),CGPoint(x:x+38,y:y+19)],key,2.5)
}
func check(_ ctx: CGContext, _ x: Double, _ y: Double, _ key: String = "mint") { line(ctx,[CGPoint(x:x,y:y+7),CGPoint(x:x+6,y:y+13),CGPoint(x:x+17,y:y)],key,3) }
func component(_ ctx: CGContext, _ x: Double, _ y: Double, _ w: Double, _ title: String, _ subtitle: String, _ kind: String, _ active: Bool = true) {
  box(ctx,rect(x,y,w,155),22,"card",active ? kind : "stroke")
  switch kind {
  case "blue": codexIcon(ctx,x+24,y+25)
  case "mint": chipIcon(ctx,x+24,y+22)
  default: globe(ctx,x+24,y+22)
  }
  text(title,x+24,y+77,25,active ? "white" : "muted",.semibold,w-48)
  text(subtitle,x+24,y+115,17,"muted",.regular,w-48)
}
func header(_ ctx: CGContext, _ step: String, _ title: String, _ subtitle: String) {
  text(step,64,126,17,"mint",.semibold)
  text(title,64,161,43,"white",.bold)
  text(subtitle,66,221,23,"muted")
}
func base(_ ctx: CGContext, _ t: Double) {
  ctx.setFillColor(color("bg").cgColor);ctx.fill(rect(0,0,1280,720))
  let g = CGGradient(colorsSpace:CGColorSpaceCreateDeviceRGB(),colors:[color("213E4E",0.38).cgColor,color("bg",0).cgColor] as CFArray,locations:[0,1])!
  ctx.drawRadialGradient(g,startCenter:CGPoint(x:1120,y:0),startRadius:0,endCenter:CGPoint(x:1120,y:0),endRadius:650,options:[])
  mark(ctx,64,57,0.9);text("PickerMux",108,39,28,"white",.semibold)
  text("HOW IT WORKS",966,48,15,"muted",.semibold,250,.right)
  line(ctx,[CGPoint(x:64,y:96),CGPoint(x:1216,y:96)],"stroke",1,0.65)
  text("Diagram · synthetic examples",64,668,15,"dim")
  text("macOS · Codex Desktop",946,668,15,"dim",.regular,270,.right)
  let labels=["Selection","Routing","Response","Tools","PickerMux"]
  let bounds=[0.0,5,13,20,30,36]
  for i in 0..<5 {
    let x=64+Double(i)*233
    let progress=clamp((t-bounds[i])/(bounds[i+1]-bounds[i]))
    box(ctx,rect(x,643,218,3),1.5,"stroke",nil)
    if progress>0 { box(ctx,rect(x,643,218*progress,3),1.5,"mint",nil) }
  }
  _ = labels
}
func scene0(_ ctx: CGContext, _ t: Double) {
  text("Your model.\nYour Codex.",64,163,66,"white",.bold,580)
  text("Local & native models\nin one model picker.",67,340,27,"muted",.regular,565)
  pill(ctx,"Choose your model and get started.",66,464,392)
  let x=680.0,y=153.0,w=536.0
  box(ctx,rect(x,y,w,415),26)
  circle(ctx,x+25,y+27,5,"dim",0.7);circle(ctx,x+43,y+27,5,"dim",0.7);circle(ctx,x+61,y+27,5,"dim",0.7)
  text("Codex Desktop",x+90,y+14,18,"muted",.medium,w-110)
  line(ctx,[CGPoint(x:x+1,y:y+54),CGPoint(x:x+w-1,y:y+54)],"stroke",1)
  text("Select a model",x+29,y+80,25,"white",.semibold,w-58)
  box(ctx,rect(x+22,y+137,w-44,88),17,"bg","stroke")
  codexIcon(ctx,x+44,y+160);text("Native model",x+101,y+152,21,"white",.medium,w-145)
  text("Through your Codex account",x+102,y+185,16,"muted",.regular,w-145)
  let active=t>1.35
  box(ctx,rect(x+22,y+238,w-44,112),17,active ? "1A383E" : "bg",active ? "mint" : "stroke")
  chipIcon(ctx,x+44,y+264)
  text("LM Studio · Example model",x+102,y+253,21,"white",.medium,w-150)
  text("lmstudio/example-model",x+102,y+289,18,active ? "mint" : "muted",.regular,w-145,.left,true)
  if active { check(ctx,x+w-60,y+269) }
  text("Illustrative interface",x+30,y+374,14,"dim")
  let p=ease((t-0.7)/1.1)
  if t<2.4 {
    let cx=x+365,cy=y+200+82*p
    ctx.setFillColor(color("white").cgColor)
    ctx.beginPath();ctx.move(to:CGPoint(x:cx,y:cy));ctx.addLine(to:CGPoint(x:cx+7,y:cy+28));ctx.addLine(to:CGPoint(x:cx+13,y:cy+19));ctx.addLine(to:CGPoint(x:cx+23,y:cy+16));ctx.closePath();ctx.fillPath()
  }
}
func scene1(_ ctx: CGContext, _ t: Double) {
  header(ctx,"01 / CHOOSE A MODEL","Every model has one exact route.","The selected model determines the provider.")
  let local=t>=3.5
  component(ctx,64,336,235,"Codex Desktop","Your interface","blue")
  box(ctx,rect(421,336,303,155),22,"172C35","mint")
  mark(ctx,447,370,1.0);text("PickerMux",448,413,29,"white",.semibold,250)
  text("Exact routing",448,455,18,"muted",.regular,250)
  component(ctx,925,276,291,"Native model","Native Codex service","blue",!local)
  component(ctx,925,466,291,"LM Studio","Local model on your Mac","mint",local)
  let left=[CGPoint(x:299,y:413),CGPoint(x:421,y:413)]
  let native=[CGPoint(x:724,y:413),CGPoint(x:804,y:413),CGPoint(x:804,y:353),CGPoint(x:925,y:353)]
  let lm=[CGPoint(x:724,y:413),CGPoint(x:850,y:413),CGPoint(x:850,y:543),CGPoint(x:925,y:543)]
  arrow(ctx,left,"mint")
  arrow(ctx,native,"blue",local ? 0.2 : 1)
  arrow(ctx,lm,"mint",local ? 1 : 0.2)
  let p=(t.truncatingRemainder(dividingBy:2.0))/2.0
  travel(ctx,left,p,"mint");travel(ctx,local ? lm : native,p,local ? "mint" : "blue")
  pill(ctx,local ? "lmstudio/example-model → LM Studio" : "Native selection → native Codex service",64,275,580,local ? "mint" : "blue")
  text("Credentials stay with their intended provider.",65,548,19,"muted",.regular,718)
}
func scene2(_ ctx: CGContext, _ t: Double) {
  header(ctx,"02 / GET THE RESPONSE","The answer comes back.","The selected model replies in your Codex interface.")
  component(ctx,64,304,267,"Codex Desktop","Response in chat","blue")
  box(ctx,rect(468,304,304,155),22,"172C35","mint")
  mark(ctx,492,340,1.0);text("PickerMux",492,382,30,"white",.semibold,260);text("Bridge on your Mac",492,423,18,"muted",.regular,264)
  component(ctx,931,304,285,"LM Studio","lmstudio/example-model","mint")
  let first=[CGPoint(x:331,y:350),CGPoint(x:468,y:350)]
  let second=[CGPoint(x:772,y:350),CGPoint(x:931,y:350)]
  let return2=[CGPoint(x:931,y:422),CGPoint(x:772,y:422)]
  let return1=[CGPoint(x:468,y:422),CGPoint(x:331,y:422)]
  let responding=t>1.6
  arrow(ctx,first,"blue",responding ? 0.22 : 0.85);arrow(ctx,second,"blue",responding ? 0.22 : 0.85)
  arrow(ctx,return2,"mint",responding ? 1 : 0.16);arrow(ctx,return1,"mint",responding ? 1 : 0.16)
  let p=(t.truncatingRemainder(dividingBy:1.7))/1.7
  if responding { travel(ctx,return2,p,"mint");travel(ctx,return1,p,"mint") } else { travel(ctx,first,p,"blue");travel(ctx,second,p,"blue") }
  text("Request",348,312,16,"dim",.medium,110,.center);text("Response",798,455,16,"mint",.medium,114,.center)
  box(ctx,rect(64,504,1152,107),18,"card",nil)
  circle(ctx,101,543,15,"blue",0.13);codexIcon(ctx,91,533,"blue")
  text("Read the response directly in Codex.",152,522,25,"white",.semibold,1010)
  text("Switch between local and native models in the same picker.",152,563,19,"muted",.regular,1010)
}
func scene3(_ ctx: CGContext, _ t: Double) {
  header(ctx,"03 / USE TOOLS","Tools: Codex runs the call.","Tool access requires certification for the exact model.")
  component(ctx,64,331,274,"Local model","Requests a tool","mint")
  component(ctx,503,331,274,"Codex Desktop","Runs the tool call","blue")
  component(ctx,942,331,274,"Web research","Via the native service","violet")
  let paths: [[CGPoint]] = [
    [CGPoint(x:338,y:369),CGPoint(x:503,y:369)],
    [CGPoint(x:777,y:369),CGPoint(x:942,y:369)],
    [CGPoint(x:942,y:445),CGPoint(x:777,y:445)],
    [CGPoint(x:503,y:445),CGPoint(x:338,y:445)]
  ]
  let phase=min(3,Int(t/2.2))
  let keys=["mint","blue","violet","mint"]
  for i in 0..<4 { arrow(ctx,paths[i],keys[i],phase==i ? 1 : 0.22) }
  let phaseElapsed=t-Double(phase)*2.2
  if phaseElapsed<2.2 { travel(ctx,paths[phase],clamp(phaseElapsed/1.6),keys[phase]) }
  let descriptions=["1  Model requests a tool","2  Codex queries the source","3  Research results return","4  Results go back to the model"]
  pill(ctx,descriptions[phase],64,273,672,keys[phase])
  text("Tool call",349,330,15,"muted",.medium,143,.center);text("Web tool",794,330,15,"muted",.medium,126,.center)
  text("Result",793,483,15,"muted",.medium,133,.center);text("Result",347,483,15,"muted",.medium,143,.center)
  box(ctx,rect(64,535,1152,78),18,"card",nil)
  globe(ctx,89,555)
  text("Web access needs internet and native Codex sign-in.",147,552,22,"white",.medium,1010)
  text("Tool availability and correct use also depend on the model.",147,583,17,"muted",.regular,1010)
}
func scene4(_ ctx: CGContext, _ t: Double) {
  mark(ctx,452,173,2.4);text("PickerMux",556,139,48,"white",.bold,475)
  text("Your model.\nThe familiar interface.",64,255,56,"white",.bold,1152,.center)
  let p=ease(t/0.7)
  ctx.saveGState();ctx.setAlpha(p)
  pill(ctx,"One picker",220,454,244,"mint");pill(ctx,"Exact routing",518,454,244,"blue");pill(ctx,"Certified tools",816,454,244,"violet")
  ctx.restoreGState()
  text("An independent community project.",64,539,21,"muted",.medium,1152,.center)
  text("Not affiliated with, endorsed by, or supported by OpenAI, Codex, or LM Studio.",64,576,17,"muted",.regular,1152,.center)
}
let frameBytes = width * height * 4
let buffer = UnsafeMutableRawPointer.allocate(byteCount: frameBytes, alignment: 64)
defer { buffer.deallocate() }
let context = CGContext(data:buffer,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
context.setAllowsAntialiasing(true)
context.setShouldAntialias(true)
func render(_ time: Double) {
  context.saveGState();context.translateBy(x:0,y:Double(height));context.scaleBy(x:1,y:-1)
  NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(cgContext:context,flipped:true)
  base(context,time)
  let boundaries=[0.0,5,13,20,30,36]
  let scene=min(4,(0..<5).first { time<boundaries[$0+1] } ?? 4)
  let local=time-boundaries[scene]
  let a=clamp(local/0.35)
  let out=scene==4 ? 1.0 : clamp((boundaries[scene+1]-time)/0.28)
  context.setAlpha(min(a,out))
  context.translateBy(x:0,y:12*(1-ease(local/0.45)))
  switch scene { case 0:scene0(context,local);case 1:scene1(context,local);case 2:scene2(context,local);case 3:scene3(context,local);default:scene4(context,local) }
  NSGraphicsContext.restoreGraphicsState();context.restoreGState()
}
if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--poster" {
  let t=Double(CommandLine.arguments[2])!
  render(t)
  let target=URL(fileURLWithPath:CommandLine.arguments[3])
  let dest=CGImageDestinationCreateWithURL(target as CFURL,"public.png" as CFString,1,nil)!
  CGImageDestinationAddImage(dest,context.makeImage()!,nil)
  guard CGImageDestinationFinalize(dest) else { fatalError("Could not write PNG") }
} else {
  for frame in 0..<Int(duration*Double(fps)) {
    autoreleasepool {
      render(Double(frame)/Double(fps))
      FileHandle.standardOutput.write(Data(bytes:buffer,count:frameBytes))
    }
  }
}
