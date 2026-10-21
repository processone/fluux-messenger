import XCTest

final class DiagnosticUITests: XCTestCase {
    func testVoluntaryShareAndCleanup() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Prêt"].waitForExistence(timeout: 10))
        app.buttons["Exporter le diagnostic"].tap()
        XCTAssertTrue(app.otherElements["LP.CaptionBar.TopCaption"].waitForExistence(timeout: 10))
        let capture = XCTAttachment(screenshot: app.screenshot()); capture.name = "Native diagnostic share sheet"; capture.lifetime = .keepAlways; add(capture)
        // Cancel without choosing a destination or uploading the file.
        app.otherElements["PopoverDismissRegion"].tap()
        XCTAssertTrue(app.staticTexts["Copie supprimée"].waitForExistence(timeout: 10))
    }
}
