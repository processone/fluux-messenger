import CoreGraphics
import Darwin

@main struct Check {
    static func main() {
        // The window, keyboard height, composer side inset and gesture inset were measured in
        // the native iPhone demo. The other frames are boundary cases in those same point units,
        // not claims that a floating keyboard was observed on that phone.
        let window = CGRect(x: 0, y: 0, width: 440, height: 956)
        let cases: [(String, CGRect, Bool)] = [
            ("recorded docked keyboard", CGRect(x: 0, y: 609, width: 440, height: 347), true),
            ("off-screen hide frame", CGRect(x: 0, y: 956, width: 440, height: 347), false),
            ("zero-height bottom overlap", CGRect(x: 0, y: 956, width: 440, height: 0), false),
            ("narrower floating frame at the bottom", CGRect(x: 19, y: 609, width: 402, height: 347), false),
            ("bottom frame leaving only the left edge uncovered", CGRect(x: 19, y: 609, width: 421, height: 347), false),
            ("bottom frame leaving only the right edge uncovered", CGRect(x: 0, y: 609, width: 421, height: 347), false),
            ("full-width frame leaving the gesture inset uncovered", CGRect(x: 0, y: 609, width: 440, height: 313), false),
        ]
        for (name, frame, expected) in cases {
            let actual = isDockedKeyboard(frame, in: window)
            guard actual == expected else {
                fputs("FAILED: \(name): expected \(expected), received \(actual)\n", stderr)
                exit(1)
            }
        }
        print("Keyboard layout passed")
    }
}
