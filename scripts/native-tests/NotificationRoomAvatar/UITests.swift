import XCTest

final class RoomAlertUITests: XCTestCase {
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
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "Room notification with room-first text"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("COLLAPSED NOTIFICATION: \(banner.debugDescription)")
        XCUIDevice.shared.press(.home)
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.01)).press(forDuration: 0.1,
            thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.8)))
        let card = springboard.descendants(matching: .any).matching(identifier: "NotificationShortLookView").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        print("NOTIFICATION CENTER: \(springboard.debugDescription)")
        let listed = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        listed.name = "Room notification in Notification Center"
        listed.lifetime = .keepAlways
        add(listed)
        card.press(forDuration: 1)
        print("EXPANDED NOTIFICATION: \(springboard.debugDescription)")
        let expanded = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        expanded.name = "Expanded room notification"
        expanded.lifetime = .keepAlways
        add(expanded)
    }
}
