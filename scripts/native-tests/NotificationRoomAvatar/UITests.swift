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
        // The retained simulator trees expose no attachment image. If a system
        // version exposes the attachment identifier, verify that image is visible.
        // Otherwise the kept settled picture still needs visual inspection.
        let image = view.images["room-avatar"]
        if image.exists {
            XCTAssertTrue(image.isHittable, "The exposed room image must be visible")
            XCTAssertFalse(image.frame.isEmpty)
        } else {
            print("ROOM IMAGE: not individually exposed to accessibility; inspect the settled capture")
        }
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // Regression source: the room image must coexist with room-before-nickname text.
    // Grant permission before posting so an unrelated app tap cannot consume the banner.
    func testObserveNativeRoomAlert() throws {
        let app = XCUIApplication()
        app.launch()
        app.buttons["Enable notifications"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let permission = springboard.alerts.firstMatch
        if permission.waitForExistence(timeout: 5) {
            let allow = permission.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "Autoriser"])).firstMatch
            XCTAssertTrue(allow.exists)
            allow.tap()
        }
        let ready = app.staticTexts.matching(NSPredicate(format: "label == %@", "Ready to post room alert")).firstMatch
        guard ready.waitForExistence(timeout: 10) else {
            XCTFail("Fixture could not obtain notification permission: \(app.staticTexts["fixture-status"].label)")
            return
        }
        app.buttons["Post room alert"].tap()
        let banner = springboard.descendants(matching: .any).matching(identifier: "NotificationShortLookView").firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 10))
        let label = banner.label
        let room = try XCTUnwrap(label.range(of: "XSF"))
        let nick = try XCTUnwrap(label.range(of: "Seve"))
        XCTAssertLessThan(room.lowerBound, nick.lowerBound, "The system banner must keep the room before the nickname")
        print("SYSTEM BANNER: \(label)")
        try captureSettled(banner, named: "Room notification with room-first text")
        print("COLLAPSED NOTIFICATION: \(banner.debugDescription)")
        XCUIDevice.shared.press(.home)
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.01)).press(forDuration: 0.1,
            thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.8)))
        let card = springboard.descendants(matching: .any).matching(identifier: "NotificationShortLookView").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        print("NOTIFICATION CENTER: \(springboard.debugDescription)")
        try captureSettled(card, named: "Room notification in Notification Center")
        card.press(forDuration: 1)
        let expanded = springboard.descendants(matching: .any).matching(identifier: "notification-expanded-view").firstMatch
        try captureSettled(expanded, named: "Expanded room notification")
        print("EXPANDED NOTIFICATION: \(springboard.debugDescription)")
    }
}
