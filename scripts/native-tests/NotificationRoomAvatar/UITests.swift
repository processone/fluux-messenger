import XCTest

final class RoomAlertUITests: XCTestCase {
    // Review regression: element existence and gesture completion precede the
    // system's rendering transition. Every capture waits for unchanged pixels
    // and geometry, then keeps that exact settled frame instead of sampling again.
    private func captureSettled(_ view: XCUIElement, named name: String) throws {
        XCTAssertTrue(view.waitForExistence(timeout: 10))
        var previousPixels: Data?
        var previousFrame: CGRect?
        var settled: XCUIScreenshot?
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard view.exists, view.isHittable, !view.frame.isEmpty else { return false }
            let frame = view.frame
            let screenshot = XCUIScreen.main.screenshot()
            let pixels = screenshot.pngRepresentation
            let unchanged = previousFrame == frame && previousPixels == pixels
            previousFrame = frame
            previousPixels = pixels
            if unchanged { settled = screenshot }
            return unchanged
        }, object: nil)
        let result = XCTWaiter.wait(for: [expectation], timeout: 10)
        let screenshot = try XCTUnwrap(result == .completed ? settled : nil,
                                      "The notification did not reach a settled rendered state")
        // Retained simulator trees expose no avatar image. If a system version
        // names an image after the notification origin, check its visibility.
        // Otherwise the exact settled picture still needs visual inspection.
        let title = view.descendants(matching: .any).matching(identifier: "NotificationTitle").firstMatch
        if title.exists {
            let image = view.images.matching(NSPredicate(format: "label == %@", title.label)).firstMatch
            if image.exists {
                XCTAssertTrue(image.isHittable, "The exposed origin image must be visible")
                XCTAssertFalse(image.frame.isEmpty)
            } else {
                print("NOTIFICATION IMAGE: not individually exposed; inspect the settled capture")
            }
        }
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // Grant permission before posting so an unrelated app tap cannot consume the banner.
    // Each journey starts a fresh fixture host; repetitions must not reuse hidden controls.
    private func postAlert(_ app: XCUIApplication, directControl: Bool = false) throws -> XCUIElement {
        app.terminate()
        app.launchArguments = directControl ? ["--direct-control"] : []
        app.launch()
        app.buttons["Enable notifications"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let permission = springboard.alerts.firstMatch
        if permission.waitForExistence(timeout: 5) {
            let allow = permission.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "Autoriser"])).firstMatch
            XCTAssertTrue(allow.exists)
            allow.tap()
        }
        let ready = app.staticTexts.matching(NSPredicate(format: "label == %@", "Ready to post alert")).firstMatch
        _ = try XCTUnwrap(ready.waitForExistence(timeout: 10) ? ready : nil,
                          "Fixture could not obtain notification permission")
        app.buttons["Post alert"].tap()
        let banner = springboard.descendants(matching: .any).matching(identifier: "NotificationShortLookView").firstMatch
        _ = try XCTUnwrap(banner.waitForExistence(timeout: 10) ? banner : nil)
        return banner
    }

    // Qualification source: unsigned controls did not render communication images.
    // Keep a distinct direct-image capture so room-image proof uses a qualified host.
    func testDirectImageCapability() throws {
        let app = XCUIApplication()
        let banner = try postAlert(app, directControl: true)
        XCTAssertTrue(banner.label.contains("Seve"))
        try captureSettled(banner, named: "Direct-message image capability control")
    }

    // Accepted room-attribution layout: room picture and name first, then nickname and message.
    func testObserveNativeRoomAlert() throws {
        let app = XCUIApplication()
        let banner = try postAlert(app)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let label = banner.label
        let room = try XCTUnwrap(label.range(of: "XSF"))
        let nick = try XCTUnwrap(label.range(of: "Seve"))
        XCTAssertLessThan(room.lowerBound, nick.lowerBound, "The system banner must keep the room before the nickname")
        print("SYSTEM BANNER: \(label)")
        try captureSettled(banner, named: "Room notification with room-first text")
        print("COLLAPSED NOTIFICATION: \(banner.debugDescription)")
        banner.press(forDuration: 1)
        let expanded = springboard.descendants(matching: .any).matching(identifier: "notification-expanded-view").firstMatch
        try captureSettled(expanded, named: "Expanded room notification")
        print("EXPANDED NOTIFICATION: \(springboard.debugDescription)")
        XCUIDevice.shared.press(.home)
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.01)).press(forDuration: 0.1,
            thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.8)))
        let card = springboard.descendants(matching: .any).matching(identifier: "NotificationShortLookView").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        print("NOTIFICATION CENTER: \(springboard.debugDescription)")
        try captureSettled(card, named: "Room notification in Notification Center")
    }
}
