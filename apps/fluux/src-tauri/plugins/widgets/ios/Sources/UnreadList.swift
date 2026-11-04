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
    static let lockName = "UnreadWidget.lock"
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

    /// What the widget may show for the account the shared names confirm. A list written for another
    /// account, or before the names caught up, is hidden and `awaitingAccount` asks for another look soon.
    static func shown(root: URL?, account: String?) -> (list: UnreadList?, awaitingAccount: Bool) {
        guard let written = load(root: root) else { return (nil, false) }
        return written.account == account ? (written, false) : (nil, true)
    }

    /// The app and the notification extension are separate processes that both change the file, so
    /// every change takes this lock: a push cannot overwrite a newer list with an older one, or bring
    /// back a list the app just emptied for a sign-out.
    private static func locked<T>(root: URL, _ body: () throws -> T) rethrows -> T {
        let descriptor = open(root.appendingPathComponent(lockName).path, O_CREAT | O_RDWR, 0o600)
        if descriptor >= 0 {
            flock(descriptor, LOCK_EX)
        }
        defer {
            if descriptor >= 0 {
                flock(descriptor, LOCK_UN)
                close(descriptor)
            }
        }
        return try body()
    }

    func write(root: URL) throws {
        try Self.locked(root: root) { try writeUnlocked(root: root) }
    }

    private func writeUnlocked(root: URL) throws {
        try JSONEncoder().encode(self).write(
            to: root.appendingPathComponent(Self.fileName),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    /// Signing out leaves nothing to show.
    static func clear(root: URL) throws {
        try locked(root: root) {
            let url = root.appendingPathComponent(fileName)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
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

    /// The notification extension's side: `total` is read once the lock is held, so a push that waited
    /// for another reads the badge after that one, never a count taken before it. Adds a pushed conversation to the file the app last wrote
    /// and asks for a redraw. iOS may defer that redraw until the app next opens; the file is right either way.
    static func recordPush(conversation: String, kind: String, name: String, account: String?,
                           total: @autoclosure () -> Int, root: URL?) {
        guard let root = root else { return }
        // Read and write under one lock: a clear or a newer list from the app lands before or after, never between.
        let added: Bool = locked(root: root) {
            guard let list = load(root: root),
                  let next = list.adding(conversation, kind: kind, name: name, account: account, total: total()) else { return false }
            return (try? next.writeUnlocked(root: root)) != nil
        }
        guard added else { return }
        #if os(iOS) && canImport(WidgetKit)
        if #available(iOS 14.0, *) { WidgetCenter.shared.reloadTimelines(ofKind: widgetKind) }
        #endif
    }
}

extension UnreadList {
    /// The time today, "Yesterday", the weekday within a week, then the date. Everything is measured
    /// against `now`, never the clock, so a timeline entry drawn ahead of time labels its day correctly.
    static func when(_ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        let today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: today).day ?? 0
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        switch days {
        case ..<1:
            formatter.timeStyle = .short
            formatter.dateStyle = .none
        case 1:
            let relative = RelativeDateTimeFormatter()
            relative.locale = locale
            relative.calendar = calendar
            relative.dateTimeStyle = .named
            let word = relative.localizedString(for: calendar.startOfDay(for: date), relativeTo: today)
            return word.prefix(1).uppercased(with: locale) + word.dropFirst()
        case 2..<7:
            formatter.setLocalizedDateFormatFromTemplate("EEE")
        default:
            formatter.timeStyle = .none
            formatter.dateStyle = .short
        }
        return formatter.string(from: date)
    }
}
