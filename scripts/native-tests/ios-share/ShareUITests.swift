import XCTest

final class ShareUITests: XCTestCase {
    // Intent: the captain's photo share must arrive as an image, not an archive (FLM-20).
    func testUIImageShareIsAnImage() { verifyImage(button: "Share UIImage", name: nil) }
    func testEncodedPNGShareIsAnImage() { verifyImage(button: "Share PNG", name: "fluux-logo.png") }

    // Intent: restoring the registered handler must allow the extension's real URL request to foreground its app.
    func testShareOpensReceiverAfterConsentIfNeeded() {
        continueAfterFailure = false
        let sender = XCUIApplication(bundleIdentifier: "org.fluux.lab.sender")
        let receiver = XCUIApplication(bundleIdentifier: "net.processone.fluux")
        receiver.terminate()
        sender.launch()
        sender.buttons["Share UIImage"].tap()
        let fluux = sender.cells["Fluux receiver"]
        XCTAssertTrue(fluux.waitForExistence(timeout: 10))
        fluux.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        if alert.waitForExistence(timeout: 5) {
            let open = alert.buttons["Open"].exists ? alert.buttons["Open"] : alert.buttons["Ouvrir"]
            open.tap()
        }
        XCTAssertTrue(receiver.wait(for: .runningForeground, timeout: 10))
        print("CONFIRMED_SHARE_RECEIVER_FOREGROUND")
    }

    private func verifyImage(button: String, name: String?) {
        continueAfterFailure = false
        let sender = XCUIApplication(bundleIdentifier: "org.fluux.lab.sender")
        let receiver = XCUIApplication(bundleIdentifier: "net.processone.fluux")
        receiver.terminate()
        sender.launch()
        sender.buttons[button].tap()
        let fluux = sender.cells["Fluux receiver"]
        XCTAssertTrue(fluux.waitForExistence(timeout: 10))
        fluux.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        if alert.waitForExistence(timeout: 5) {
            // Keep payload assertions independent of the separate activation journey.
            let cancel = alert.buttons["Cancel"].exists ? alert.buttons["Cancel"] : alert.buttons["Annuler"]
            cancel.tap()
        }
        // Do not relaunch a receiver already opened by the share: its startup consumes the inbox.
        receiver.activate()
        let result = receiver.staticTexts["import-result"]
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        print("SHARE_IMPORT_RESULT \(result.label)")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.lifetime = .keepAlways
        add(shot)
        let fields = result.label.components(separatedBy: " | ")
        XCTAssertEqual(fields.count, 4)
        XCTAssertTrue(fields[0].hasSuffix(".png"), "The filename must match the encoded image format")
        if let name { XCTAssertEqual(fields[0], name) }
        XCTAssertEqual(Array(fields.dropFirst()), ["image/png", "public.png", "decodable=true"])
    }
}
