// Native input for the isolated composer caret lab; never targets an installed app.
import AppKit
import CoreGraphics
import ApplicationServices
let a = CommandLine.arguments
let pid = pid_t(a[1])!
let p = NSRunningApplication(processIdentifier: pid)
let expected = URL(fileURLWithPath: a[2]).standardizedFileURL.path
if p?.bundleIdentifier != "net.processone.fluux.startup-lab" || p?.bundleURL?.standardizedFileURL.path != expected {
    fputs("Refused: target is not this task's disposable Fluux app\n", stderr); exit(2)
}
if !CGPreflightPostEventAccess() { fputs("Posting native pointer events not permitted\n", stderr); exit(3) }
let point = CGPoint(x:Double(a[3])!,y:Double(a[4])!)
let flags: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = CGWindowListCopyWindowInfo(flags, kCGNullWindowID) as? [[String:Any]] ?? []
let own = windows.compactMap { entry -> (CGRect, Int)? in
    guard (entry[kCGWindowOwnerPID as String] as? Int) == Int(pid),
          (entry[kCGWindowLayer as String] as? Int) == 0,
          let bounds=entry[kCGWindowBounds as String] as? [String:CGFloat],
          let number=entry[kCGWindowNumber as String] as? Int else { return nil }
    let rect=CGRect(x:bounds["X"]!,y:bounds["Y"]!,width:bounds["Width"]!,height:bounds["Height"]!)
    return (rect,number)
}.first { $0.0.width>350 && $0.0.height>500 }
guard let (bounds, wid)=own else { fputs("Refused: no task app window\n", stderr); exit(4) }
if a.count>5 && a[5]=="bounds" {
    print("\(wid) \(bounds.minX) \(bounds.minY) \(bounds.width) \(bounds.height)"); exit(0)
}
if a.count>5 && a[5]=="activate" { _=p?.activate(options:[]); exit(0) }
if a.count>5 && a[5]=="key" {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    guard AXIsProcessTrusted() else { print("unavailable accessibility-not-trusted"); exit(0) }
    var window: CFTypeRef?
    let got = AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as CFString, &window)
    if got == .success && window != nil && own?.1 == wid && front { print("focused \(wid)") }
    else { print("not-focused \(wid)") }
    exit(0)
}
if a.count>5 && ["x", "backspace"].contains(a[5]) {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { exit(4) }
    let key: CGKeyCode = a[5] == "x" ? 7 : 51
    let source = CGEventSource(stateID: .privateState)
    for down in [true, false] {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { exit(5) }
        event.flags = []
        event.postToPid(pid)
    }
    exit(0)
}
guard bounds.contains(point), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { fputs("Refused: point not on the frontmost task app\n", stderr); exit(4) }
let firstWindowAtPoint = windows.first { w in
    guard (w[kCGWindowLayer as String] as? Int) == 0,
          let b=w[kCGWindowBounds as String] as? [String:CGFloat] else { return false }
    return CGRect(x:b["X"]!,y:b["Y"]!,width:b["Width"]!,height:b["Height"]!).contains(point)
}
guard (firstWindowAtPoint?[kCGWindowNumber as String] as? Int) == wid else { fputs("Refused: another window covers the task point\n", stderr); exit(4) }
let source=CGEventSource(stateID:.combinedSessionState)
let previous=CGEvent(source:nil)?.location
CGWarpMouseCursorPosition(point)
if let movement=CGEvent(mouseEventSource:source,mouseType:.mouseMoved,mouseCursorPosition:point,mouseButton:.left) { movement.post(tap:.cgSessionEventTap) }
usleep(60_000)
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { fputs("Refused: task app lost foreground before click\n", stderr); exit(4) }
for type: CGEventType in [.leftMouseDown,.leftMouseUp] {
    guard let e=CGEvent(mouseEventSource:source,mouseType:type,mouseCursorPosition:point,mouseButton:.left) else { exit(5) }
    e.setIntegerValueField(.mouseEventClickState,value:1); e.post(tap:.cgSessionEventTap)
    if type == .leftMouseDown { usleep(35_000) }
}
// A recording is sampled after delivery rather than after instantaneous cursor relocation.
usleep(70_000)
if let previous, NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, bounds.contains(previous) {CGWarpMouseCursorPosition(previous)}
print("\(wid) \(bounds.minX) \(bounds.minY) \(bounds.width) \(bounds.height)")
