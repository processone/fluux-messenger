import XCTest

final class NotificationTapTests: XCTestCase {
    // FLM-95: OS-delivered local taps must retain the plugin's real userInfo,
    // never its actionPerformed envelope (which omits extra on iOS).
    func testLocalTaps() {
        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "Notifications") { alert in
            let allow = alert.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "Autoriser"])).firstMatch
            if allow.exists { allow.tap(); return true }
            return false
        }
        app.launch(); app.tap()
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // Keep this to two posts: iOS may suppress a third rapid foreground banner.
        for kind in ["conversation", "room"] {
            app.buttons["Post \(kind)"].tap()
            // iOS 26 exposes this as BannerNotification, not Other.
            let banner = system.descendants(matching: .any).matching(identifier: "NotificationShortLookView").firstMatch
            XCTAssertTrue(banner.waitForExistence(timeout: 10))
            attach(XCUIScreen.main.screenshot(), "\(kind) banner")
            banner.tap()
            let payload = app.staticTexts["payload"]
            let retained = expectation(for: NSPredicate(format: "label BEGINSWITH %@", "Retained tap:"), evaluatedWith: payload)
            wait(for: [retained], timeout: 5)
            XCTAssertTrue(payload.label.contains("__EXTRA__"))
            attach(app.screenshot(), "\(kind) tap payload")
            print("ACTUAL \(kind): \(payload.label)")
        }
    }

    private func attach(_ screenshot: XCUIScreenshot, _ name: String) {
        let capture = XCTAttachment(screenshot: screenshot)
        capture.name = name; capture.lifetime = .keepAlways; add(capture)
    }
}
