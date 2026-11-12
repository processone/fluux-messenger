import XCTest

/// Steps run in order on one simulator (test1 ... test5); each one keeps the widget placed by test1.
final class WidgetsUITests: XCTestCase {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let app = XCUIApplication()

    override func setUp() { continueAfterFailure = false }

    func shot(_ label: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = label
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Keeps a picture and the springboard tree, so a missing element can be diagnosed from the result.
    func dump(_ label: String) {
        shot(label)
        let tree = XCTAttachment(string: springboard.debugDescription)
        tree.name = label + "-tree"
        tree.lifetime = .keepAlways
        add(tree)
    }

    func first(_ queries: [XCUIElementQuery], _ labels: [String], timeout: TimeInterval = 5) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            for query in queries { for label in labels {
                let element = query.matching(NSPredicate(format: "label ==[c] %@ OR identifier ==[c] %@", label, label)).firstMatch
                if element.exists { return element }
            } }
            usleep(300_000)
        } while Date() < deadline
        return nil
    }

    func must(_ element: XCUIElement?, _ step: String) -> XCUIElement {
        guard let element else { dump("missing-\(step)"); XCTFail("missing \(step)"); fatalError() }
        return element
    }

    /// An element anywhere on the home screen whose label holds the text (a widget row is not a plain static text).
    func onHome(_ text: String, timeout: TimeInterval = 10) -> XCUIElement? {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@", text)
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let match = springboard.descendants(matching: .any).matching(predicate).firstMatch
            if match.exists { return match }
            usleep(500_000)
        } while Date() < deadline
        return nil
    }

    /// Goes home and swipes through the pages until the widget's own text (`marker`) is on screen.
    func showWidgetPage(_ marker: String) -> Bool {
        XCUIDevice.shared.press(.home)
        sleep(1)
        for _ in 0..<4 {
            if onHome(marker, timeout: 3) != nil { return true }
            springboard.swipeLeft()
        }
        return false
    }

    func launchHost(_ argument: String) {
        app.terminate()
        app.launchArguments = [argument]
        app.launch()
        XCTAssertTrue(app.staticTexts["ready"].waitForExistence(timeout: 30), "host finished its step: \(argument)")
    }

    func test1AddFromGalleryAndShowRows() throws {
        launchHost("-seed")
        XCUIDevice.shared.press(.home)
        sleep(2)
        dump("01-home")
        let icon = must(first([springboard.icons], ["Fluux Lab"], timeout: 10), "app-icon")
        icon.press(forDuration: 1.5)
        sleep(1)
        dump("02-icon-menu")
        must(first([springboard.buttons, springboard.menuItems, springboard.cells], ["Edit Home Screen", "Edit"], timeout: 5), "edit-home").tap()
        sleep(2)
        dump("03-jiggle")
        must(first([springboard.buttons], ["Edit", "Add", "Add Widget", "Add widget"], timeout: 5), "edit-button").tap()
        sleep(1)
        if let add = first([springboard.buttons, springboard.menuItems, springboard.cells, springboard.staticTexts], ["Add Widget", "Add widget"], timeout: 3) { add.tap() }
        sleep(2)
        dump("04-gallery")
        let search = must(first([springboard.searchFields, springboard.textFields], ["Search Widgets", "Search widgets", "Search"], timeout: 8), "gallery-search")
        search.tap()
        search.typeText("Fluux Lab")
        sleep(2)
        dump("05-search")
        must(first([springboard.cells, springboard.buttons, springboard.staticTexts, springboard.otherElements], ["Fluux Lab"], timeout: 8), "gallery-entry").tap()
        sleep(2)
        dump("06-widget-detail")
        // Rows are links from the medium size up: the second size.
        springboard.swipeLeft()
        sleep(1)
        dump("07-medium")
        must(first([springboard.buttons], [" Add Widget", "Add Widget"], timeout: 5), "add-widget").tap()
        sleep(2)
        if let done = first([springboard.buttons], ["Done"], timeout: 3) { done.tap() } else { XCUIDevice.shared.press(.home) }
        sleep(3)
        dump("08-widget-added")
        XCTAssertNotNil(onHome("Alice Lab", timeout: 15), "the seeded row is on the home screen")
        XCTAssertNotNil(onHome("1 unread"), "the unread total is on the home screen")
        shot("09-rows-and-avatar")
    }

    func test2RowTapOpensConversationLink() throws {
        XCUIDevice.shared.press(.home)
        sleep(1)
        // A home press from a fresh state shows the first page; the widget sits beside the app's icon.
        var row = onHome("Alice Lab", timeout: 3)
        for _ in 0..<3 where row == nil {
            springboard.swipeLeft()
            row = onHome("Alice Lab", timeout: 3)
        }
        must(row, "row").tap()
        let opened = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'shortcut' AND label CONTAINS 'alice@lab.test'")).firstMatch
        XCTAssertTrue(opened.waitForExistence(timeout: 15), "the host opened a shortcut link for Alice")
        shot("10-row-tap-opened")
        let link = opened.label
        XCTAssertTrue(link.hasPrefix("org.fluux.lab.widgets://shortcut?"), link)
        XCTAssertTrue(link.contains("account=me@lab.test") || link.contains("account=me%40lab.test"), link)
        XCTAssertTrue(link.contains("kind=chat"), link)
    }

    func test3PushAddsRowThroughProductionService() throws {
        launchHost("-push")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'delivered'")).firstMatch.waitForExistence(timeout: 10),
                      "the production NotificationService delivered the push")
        XCUIDevice.shared.press(.home)
        sleep(3)
        XCTAssertTrue(showWidgetPage("Alice Lab"), "the widget's page can be found by swiping")
        shot("11-after-push")
        XCTAssertNotNil(onHome("Bob Lab", timeout: 20), "the pushed conversation was added to the widget")
        XCTAssertNotNil(onHome("Alice Lab"), "the listed conversation stays")
    }

    func test4SignOutShowsSignInMessage() throws {
        launchHost("-signout")
        XCUIDevice.shared.press(.home)
        sleep(3)
        dump("12-signed-out")
        XCTAssertNotNil(onHome("Sign in to Fluux", timeout: 20), "the sign-in message is shown after sign-out")
        XCTAssertNil(onHome("Alice Lab", timeout: 2), "no row remains")
        XCTAssertNil(onHome("Bob Lab", timeout: 1), "no pushed row remains")
    }

    /// The iOS timeline asks to be built again about an hour on. The list changes with no redraw request;
    /// the widget must show the change by itself within the hour plus the system's slack (it takes about an hour).
    func test5WidgetRereadsFileAboutHourlyWithoutRedrawRequest() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["FLUUX_WIDGETS_HOURLY"] == "1",
                          "waits about an hour: set FLUUX_WIDGETS_HOURLY=1 to run it")
        launchHost("-seed")
        XCTAssertTrue(showWidgetPage("Alice Lab"), "the seeded row is shown before the silent change")
        XCTAssertNil(onHome("Carol Lab", timeout: 1))
        launchHost("-silentchange")
        app.terminate()
        let changedAt = Date()
        XCTAssertTrue(showWidgetPage("Alice Lab"), "the widget is still on screen after the silent change")
        dump("13-silent-change-written")
        XCTAssertNil(onHome("Carol Lab", timeout: 2), "no redraw was requested, so the change is not shown at once")
        // The row must not show before the timeline's own hour is up, so a reload from any other cause
        // cannot pass as the hourly re-read. Each poll first finds the widget's page, so a miss means the
        // widget did not redraw, not that it was off screen; the springboard tree is kept every 10 minutes.
        var lastDump = Date()
        while Date().timeIntervalSince(changedAt) < 80 * 60 {
            let onScreen = showWidgetPage("Alice Lab")
            if onHome("Carol Lab", timeout: 5) != nil {
                let minutes = Int(Date().timeIntervalSince(changedAt) / 60)
                dump("15-after-hourly-reread")
                let note = XCTAttachment(string: "Carol Lab shown \(minutes) minutes after the silent change")
                note.lifetime = .keepAlways
                add(note)
                XCTAssertGreaterThanOrEqual(minutes, 55, "the row came from another reload, not the hourly re-read (\(minutes) minutes)")
                return
            }
            if Date().timeIntervalSince(lastDump) > 600 || !onScreen {
                dump("14-poll-\(Int(Date().timeIntervalSince(changedAt) / 60))min-widgetOnScreen-\(onScreen)")
                lastDump = Date()
            }
            sleep(30)
        }
        _ = showWidgetPage("Alice Lab")
        dump("15-no-reread")
        XCTFail("the widget did not show the silent change within 80 minutes")
    }
}
