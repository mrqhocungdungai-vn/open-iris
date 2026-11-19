// Tiny mouse driver: reads lines on stdin and posts CGEvents.
//   move|down|up|right <x> <y>   global screen points (right = full right click)
//   scroll <dx> <dy>             pixels
// Needs Accessibility permission for the app that launched it, otherwise macOS drops the events silently.
import AppKit
import Foundation

print(AXIsProcessTrusted() ? "trusted" : "untrusted")
fflush(stdout)

func post(_ type: CGEventType, _ pt: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
  let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: pt, mouseButton: button)
  e?.setIntegerValueField(.mouseEventClickState, value: clicks) // without this, two quick clicks are never a double-click
  e?.post(tap: .cghidEventTap)
}

var down = false
var clicks: Int64 = 1
var lastDown = (time: Date.distantPast, pt: CGPoint.zero)
while let line = readLine() {
  let p = line.split(separator: " ")
  guard p.count == 3, let x = Double(p[1]), let y = Double(p[2]) else { continue }
  let pt = CGPoint(x: x, y: y)
  switch p[0] {
  case "down":
    // Second pinch within the system double-click interval, near the first: count it as a double-click (opens folders/apps).
    let near = hypot(pt.x - lastDown.pt.x, pt.y - lastDown.pt.y) < 25 // hand jitter is bigger than a real mouse's
    clicks = near && Date().timeIntervalSince(lastDown.time) < NSEvent.doubleClickInterval ? clicks + 1 : 1
    lastDown = (Date(), pt)
    down = true
    post(.leftMouseDown, pt, clicks: clicks)
  // Only when held, at the cursor's own spot: the safety "up 0 0" on stop/quit must not jump the cursor to the corner.
  case "up": if down { down = false; post(.leftMouseUp, CGEvent(source: nil)?.location ?? pt, clicks: clicks) }
  case "right": post(.rightMouseDown, pt, .right); post(.rightMouseUp, pt, .right)
  case "scroll":
    CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(y), wheel2: Int32(x), wheel3: 0)?
      .post(tap: .cghidEventTap)
  default: post(down ? .leftMouseDragged : .mouseMoved, pt)
  }
}
