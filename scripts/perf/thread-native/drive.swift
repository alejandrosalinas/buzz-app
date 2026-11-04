// Synthetic pointer and trackpad input for the native thread-scroll harness.
//   drive move <x> <y>
//   drive click <x> <y>
//   drive fling <x> <y> <v0 px/s> [<v0> ...]
// A fling is a 64ms finger gesture ramping to v0, then a momentum coast that
// decays 3% every 16ms until it falls under 0.5px. Positive velocity scrolls
// toward older content. With FLING_COAST_MS, a following fling interrupts the
// coast after that many milliseconds, as a second swipe does.
import Cocoa

let a = CommandLine.arguments
let src = CGEventSource(stateID: .hidSystemState)

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }
func move(_ p: CGPoint) {
  post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
}
func wheel(_ dy: Double, phase: Int64, momentum: Int64) {
  let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1,
                  wheel1: Int32(dy.rounded()), wheel2: 0, wheel3: 0)
  e?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
  e?.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
  e?.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
  e?.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: dy)
  e?.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: dy)
  post(e)
}
func sleepMs(_ ms: Double) { usleep(useconds_t(ms * 1000)) }

switch a[1] {
case "move":
  move(CGPoint(x: Double(a[2])!, y: Double(a[3])!))
case "click":
  let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
  move(p); sleepMs(80)
  post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left))
  sleepMs(50)
  post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
case "fling":
  move(CGPoint(x: Double(a[2])!, y: Double(a[3])!)); sleepMs(50)
  let coast = Double(ProcessInfo.processInfo.environment["FLING_COAST_MS"] ?? "100000")!
  let flings = a[4...].map { Double($0)! }
  for (i, v0) in flings.enumerated() {
    // A touch that interrupts a coast starts with mayBegin, as a trackpad does.
    if i > 0 { wheel(0, phase: 128, momentum: 0); sleepMs(16) }
    wheel(0, phase: 1, momentum: 0)  // began
    for k in 1...8 { wheel(v0 * 0.008 * Double(k) / 8, phase: 2, momentum: 0); sleepMs(8) }
    wheel(0, phase: 4, momentum: 0)  // ended
    var dy = v0 * 0.016
    var t = 0.0
    let last = i == flings.count - 1
    wheel(dy, phase: 0, momentum: 1)  // momentum begin
    while abs(dy) > 0.5 && (last || t < coast) {
      sleepMs(16); t += 16
      dy *= 0.97
      wheel(dy, phase: 0, momentum: 2)  // momentum continue
    }
    wheel(0, phase: 0, momentum: 3)  // momentum end
  }
default:
  print("unknown command"); exit(2)
}
