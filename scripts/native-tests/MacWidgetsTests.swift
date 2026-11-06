import AppKit
import SwiftUI
import WidgetKit
import CryptoKit

@_silgen_name("fluux_desktop_widgets_apply")
func loadDesktopWidget(_ operation: UnsafePointer<CChar>, _ json: UnsafePointer<CChar>) -> Int32

/// Accepted native macOS widget plan: exercise the actual shared-file adapter and views using
/// disposable metadata and a real image from the project, without resolving an App Group or signing.
@main
struct MacWidgetsTests {
    @MainActor static func main() throws {
        let args = CommandLine.arguments
        let root = URL(fileURLWithPath: args[1], isDirectory: true)
        let output = URL(fileURLWithPath: args[2], isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        var reloads = 0
        func apply<T: Encodable>(_ operation: String, _ value: T) throws -> Bool {
            try DesktopWidgets.receive(operation, data: encoder.encode(value), root: root, reload: { reloads += 1 })
        }
        func check(_ condition: Bool, _ message: String) {
            precondition(condition, message)
            print("PASS: \(message)")
        }
        let loaded = "list".withCString { operation in
            "null".withCString { json in loadDesktopWidget(operation, json) }
        }
        // The scratch bundle has no App Group metadata: -1 means the optional library loaded
        // and reached its storage boundary; -2 would mean the loader could not open the library.
        check(loaded == -1, "Objective-C loader reaches the real optional Swift writer without resolving a container")
        let now = Date()
        let bytes = try Data(contentsOf: URL(fileURLWithPath: args[3]))
        let hash = Insecure.SHA1.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        var names = SharedNames(contacts: ["alice@example.com": "Alice Martin"],
                                rooms: ["dev@conference.example.com": "ejabberd-dev"],
                                avatars: ["alice@example.com": hash], account: "me@example.com")
        let rows: [UnreadList.Row] = [
            .init(id: "alice@example.com", kind: "chat", name: "Alice Martin", unread: 2, mentions: 0, last: now.timeIntervalSince1970 * 1000),
            .init(id: "dev@conference.example.com", kind: "groupchat", name: "ejabberd-dev", unread: 14, mentions: 1, last: now.addingTimeInterval(-600).timeIntervalSince1970 * 1000),
            .init(id: "bruno@example.com", kind: "chat", name: "Bruno Roux", unread: 1, mentions: 0, last: now.addingTimeInterval(-86400).timeIntervalSince1970 * 1000),
            .init(id: "release@conference.example.com", kind: "groupchat", name: "Release team", unread: 4, mentions: 0, last: now.addingTimeInterval(-2 * 86400).timeIntervalSince1970 * 1000),
            .init(id: "chloe@example.com", kind: "chat", name: "Chloé Lambert", unread: 1, mentions: 0, last: now.addingTimeInterval(-3 * 86400).timeIntervalSince1970 * 1000),
            .init(id: "users@conference.example.com", kind: "groupchat", name: "fluux-users", unread: 3, mentions: 1, last: now.addingTimeInterval(-9 * 86400).timeIntervalSince1970 * 1000),
        ]
        var list = UnreadList(account: "me@example.com", total: rows.count + 1, rows: rows, updated: now.timeIntervalSince1970 * 1000)
        check(try apply("names", names), "names written")
        check(reloads == 0, "full names mirror does not request a widget refresh")
        check(try apply("list", list), "unread list written")
        check(reloads == 1, "changed unread list requests a refresh")
        check(try !apply("list", list), "identical unread list is not rewritten")
        check(reloads == 1, "identical unread list does not request another refresh")
        check(UnreadList.shown(root: root, account: names.account).list == list, "widget reads the desktop writer's shared list")
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(UnreadList.fileName))) as! [String: Any]
        let savedRow = (json["rows"] as! [[String: Any]])[0]
        check(Set(savedRow.keys) == Set(["id", "kind", "name", "unread", "mentions", "last"]), "rows contain only accepted metadata, no message text")
        check(UnreadList.shown(root: root, account: "other@example.com").list == nil, "another account cannot display the saved list")
        func avatar(_ account: String, _ hash: String) throws -> Bool {
            try DesktopWidgets.receive("avatar", data: JSONSerialization.data(withJSONObject: ["account": account, "hash": hash, "data": bytes.base64EncodedString()]), root: root, reload: { reloads += 1 })
        }
        check(try !avatar("other@example.com", hash), "another account cannot write an avatar")
        check(try !avatar("me@example.com", "../escape"), "avatar hashes cannot escape storage")
        check(try avatar("me@example.com", hash), "real image is reduced and saved")
        check(reloads == 1, "avatar mirror does not request a widget refresh")
        let imageURL = NotificationMirror.imageURL(for: rows[0].id, names: names, root: root)
        check(imageURL.flatMap { NSImage(contentsOf: $0) } != nil, "macOS decodes the widget avatar")
        let link = ShortcutConversation(id: rows[0].id, name: rows[0].name, kind: rows[0].kind, account: list.account).url(scheme: "net.processone.fluux")!
        let components = URLComponents(url: link, resolvingAgainstBaseURL: false)!
        check(components.host == "shortcut" && components.queryItems?.first(where: { $0.name == "account" })?.value == list.account, "row link carries its account and destination")
        // The captain selected fifteen minutes for both publication heartbeat and saved-list age.
        let expectedStale = Date(timeIntervalSince1970: list.updated / 1000).addingTimeInterval(15 * 60)
        check(list.staleDate == expectedStale, "saved-list deadline is exactly fifteen minutes after updated")

        // Render the product SwiftUI source, not a recreation of its design. This does not host WidgetKit.
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        for language in ["en", "fr"] {
            for (label, family, width, height) in [("small", WidgetFamily.systemSmall, 170.0, 170.0),
                                                  ("medium", .systemMedium, 360.0, 170.0),
                                                  ("large", .systemLarge, 360.0, 380.0)] {
                func render(_ state: String, _ shown: UnreadList?, _ date: Date) throws {
                    let view = UnreadWidgetContent(entry: UnreadEntry(date: date, list: shown, names: names, root: root),
                                                   family: family, scheme: "net.processone.fluux")
                        .environment(\.locale, Locale(identifier: language))
                        .environment(\.colorScheme, .light)
                        .padding(16).frame(width: width, height: height).background(Color(nsColor: .windowBackgroundColor))
                    // Link uses native controls that ImageRenderer replaces with an unsupported-view
                    // placeholder. Host the real content in an offscreen AppKit window instead.
                    let hosting = NSHostingView(rootView: view)
                    let rect = NSRect(x: 0, y: 0, width: width, height: height)
                    let window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
                    window.contentView = hosting
                    hosting.frame = rect
                    hosting.layoutSubtreeIfNeeded()
                    window.displayIfNeeded()
                    guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
                        fatalError("Could not render \(state)")
                    }
                    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
                    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("\(language)-\(label)-\(state).png"))
                    window.orderOut(nil)
                }
                try render("unread", list, now)
                try render("stale", list, list.staleDate.addingTimeInterval(1))
                try render("empty", UnreadList(account: list.account, total: 0, rows: [], updated: list.updated), now)
                try render("signed-out", nil, now)
            }
        }
        names.account = "other@example.com"
        check(try apply("names", names), "account replacement writes new ownership")
        check(NotificationMirror.imageURL(for: rows[0].id, names: names, root: root) == nil, "account replacement removes old avatar bytes")
        list.rows = []
        list.total = 0
        check(try apply("list", Optional<UnreadList>.none), "sign-out clears native metadata")
        check(UnreadList.load(root: root) == nil && SharedNames.load(root: root).account == nil, "sign-out leaves neither rows nor account names")
        do {
            _ = try DesktopWidgets.apply("list", data: Data("not JSON".utf8), root: root)
            fatalError("Malformed list accepted")
        } catch { print("PASS: malformed list rejected without restoring signed-out data") }
        print("Desktop shared-list, avatar, link, stale-state and rendered-view checks passed")
    }
}
