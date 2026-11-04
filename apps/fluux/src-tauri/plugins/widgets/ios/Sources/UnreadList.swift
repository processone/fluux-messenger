import Foundation
#if os(iOS) && canImport(WidgetKit)
import WidgetKit
#endif

/// The conversations the app icon badge counts, as the app writes them for the
/// home-screen widget. A row holds a name, counts and a time, never message text.
///
/// The app replaces the whole list whenever its unread state changes. While the
/// app is suspended, a push from a conversation not yet listed adds a row.
struct UnreadList: Codable, Equatable {
    struct Row: Codable, Equatable, Identifiable {
        let id: String
        /// `chat` or `groupchat`.
        let kind: String
        let name: String
        let unread: Int
        let mentions: Int
        /// Time of the latest message in milliseconds since the epoch; 0 when unknown.
        let last: Double

        var date: Date? { last > 0 ? Date(timeIntervalSince1970: last / 1000) : nil }
    }

    static let fileName = "UnreadWidget.json"
    /// Matches the kind of the widget's configuration.
    static let widgetKind = "FluuxUnreadWidget"
    /// The widget's largest size shows six rows; a few more keep a push-added row from displacing a listed one.
    static let maxRows = 12

    var account: String
    var total: Int
    var rows: [Row]
    /// When the app wrote the list, in milliseconds since the epoch.
    var updated: Double

    static func load(root: URL?) -> UnreadList? {
        guard let url = root?.appendingPathComponent(fileName),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(UnreadList.self, from: data)
    }

    func write(root: URL) throws {
        try JSONEncoder().encode(self).write(
            to: root.appendingPathComponent(Self.fileName),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    /// Signing out leaves nothing to show.
    static func clear(root: URL) throws {
        let url = root.appendingPathComponent(fileName)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }

    /// A push from a conversation not yet listed adds it, with the badge's new total.
    /// A conversation already listed, or another account's list, stays as it is.
    func adding(_ conversation: String, kind: String, name: String, account owner: String?,
                total: Int, now: Date = Date()) -> UnreadList? {
        guard owner == account, !rows.contains(where: { $0.id == conversation }) else { return nil }
        var next = self
        let row = Row(id: conversation, kind: kind, name: name, unread: 1, mentions: 0, last: now.timeIntervalSince1970 * 1000)
        next.rows = Array(([row] + rows).prefix(Self.maxRows))
        next.total = total
        next.updated = row.last
        return next
    }

    /// The notification extension's side: adds a pushed conversation to the file the app last wrote
    /// and asks for a redraw. iOS may defer that redraw until the app next opens; the file is right either way.
    static func recordPush(conversation: String, kind: String, name: String, account: String?,
                           total: Int, root: URL?) {
        guard let root = root, let list = load(root: root),
              let next = list.adding(conversation, kind: kind, name: name, account: account, total: total),
              (try? next.write(root: root)) != nil else { return }
        #if os(iOS) && canImport(WidgetKit)
        if #available(iOS 14.0, *) { WidgetCenter.shared.reloadTimelines(ofKind: widgetKind) }
        #endif
    }
}
