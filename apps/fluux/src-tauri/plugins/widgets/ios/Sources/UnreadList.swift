import Foundation
#if os(iOS) && canImport(WidgetKit)
import WidgetKit
#endif

/// The conversations the app icon badge counts, as the app writes them for the
/// home-screen widget. A row holds a name, counts and a time, never message text.
///
/// The caught-up app checks/replaces the whole list against shared state. While
/// suspended, a newly counted push reconciles membership and republishes its row.
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
    /// State snapshot time (app projection or counted push), in milliseconds since the epoch.
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
    private static func locked<T>(root: URL, _ body: () throws -> T) throws -> T {
        let descriptor = open(root.appendingPathComponent(lockName).path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { flock(descriptor, LOCK_UN) }
        return try body()
    }

    func write(root: URL) throws {
        try Self.locked(root: root) { try writeUnlocked(root: root) }
    }

    /// Only the shared file can tell whether an extension changed our last app snapshot.
    /// Ignore the build timestamp, as the former app-side cache did, but compare under the writer lock.
    enum AppWrite: Equatable { case written, current, superseded }
    private struct BadgeStamp: Decodable { let account: String?; let updated: Double? }

    func publish(root: URL, clock: () -> Date = Date.init) throws -> AppWrite {
        try Self.locked(root: root) {
            let current = Self.load(root: root)
            if let current, sameContent(as: current) { return .current }
            // A frame queued before a newer extension mutation must not erase that unread row.
            // Ignore future stamps after a wall-clock rollback rather than blocking publication indefinitely.
            let now = clock().timeIntervalSince1970 * 1000
            func newer(_ owner: String?, _ time: Double?) -> Bool {
                owner == account && time.map { $0 > updated && $0 <= now } == true
            }
            if let current, newer(current.account, current.updated) { return .superseded }
            if let data = try? Data(contentsOf: root.appendingPathComponent("NotificationBadge.json")),
               let badge = try? JSONDecoder().decode(BadgeStamp.self, from: data), newer(badge.account, badge.updated) {
                return .superseded
            }
            try writeUnlocked(root: root)
            return .written
        }
    }

    @discardableResult
    func writeIfChanged(root: URL) throws -> Bool { try publish(root: root) == .written }

    private func sameContent(as other: UnreadList) -> Bool {
        account == other.account && total == other.total && rows == other.rows
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

    /// A projection of the badge's full membership, read once under the shared writer lock.
    /// Kept independent of the push package's Codable type.
    struct BadgeSnapshot {
        let account: String?
        let unread: Set<String>
        let total: Int
        let updated: Double?
        init(account: String?, unread: [String], total: Int, updated: Double? = nil) {
            self.account = account; self.unread = Set(unread); self.total = total; self.updated = updated
        }
    }

    /// Keep only currently counted rows, then add this push if it still counts.
    /// A smaller total alone cannot identify which old conversation was read.
    func adding(_ conversation: String, kind: String, name: String, account owner: String?,
                badge: BadgeSnapshot, now: Date = Date()) -> UnreadList? {
        guard owner == account, badge.account == account, badge.total >= badge.unread.count else { return nil }
        var next = self
        var seen = Set<String>()
        next.rows = rows.filter { badge.unread.contains($0.id) && seen.insert($0.id).inserted }
        if badge.unread.contains(conversation), !seen.contains(conversation) {
            next.rows.insert(.init(id: conversation, kind: kind, name: name, unread: 1, mentions: 0,
                                   last: now.timeIntervalSince1970 * 1000), at: 0)
        }
        next.rows = Array(next.rows.prefix(Self.maxRows))
        next.total = badge.total
        // The hook represents a newly counted conversation. Republish even an existing row so
        // a cached empty timeline can recover, but never replace the app's more precise row counts.
        guard !next.sameContent(as: self) || badge.unread.contains(conversation) else { return nil }
        next.updated = badge.updated ?? now.timeIntervalSince1970 * 1000
        return next
    }

    /// Content-free observations from the notification extension, not proof that WidgetKit rendered.
    struct PushEvent: Equatable {
        enum Decision { case listUnavailable, badgeUnavailable, accountMismatch, notCounted, alreadyListed, rowSelected,
                             writeSucceeded, writeFailed, countMismatch, reloadRequested, reloadUnavailable }
        let decision: Decision
        let time: TimeInterval
    }

    /// The account-owned badge is read under the shared lock, so membership and total are coherent.
    /// Return only fixed decisions and their times; the caller owns diagnostic persistence.
    @discardableResult
    static func recordPush(conversation: String, kind: String, name: String, account: String?,
                           badge: @autoclosure () -> BadgeSnapshot?, root: URL?,
                           clock: () -> Date = Date.init,
                           reload: () -> Bool = requestReload) -> [PushEvent] {
        func event(_ decision: PushEvent.Decision) -> PushEvent {
            PushEvent(decision: decision, time: clock().timeIntervalSince1970)
        }
        guard let root = root else { return [] }
        // Keep diagnostic I/O outside this lock: it must not delay another list writer or sign-out.
        var events: [PushEvent]
        do {
            events = try locked(root: root) {
                guard let list = load(root: root) else { return [event(.listUnavailable)] }
                guard list.account == account else { return [event(.accountMismatch)] }
                guard let badge = badge(), badge.total >= badge.unread.count else { return [event(.badgeUnavailable)] }
                guard badge.account == account else { return [event(.accountMismatch)] }
                // Legacy inconsistent input is observable even though the new merge repairs it.
                var observations: [PushEvent] = list.total < list.rows.count ? [event(.countMismatch)] : []
                let decision: PushEvent.Decision = !badge.unread.contains(conversation) ? .notCounted
                    : list.rows.contains(where: { $0.id == conversation }) ? .alreadyListed : .rowSelected
                observations.append(event(decision))
                guard let next = list.adding(conversation, kind: kind, name: name, account: account,
                                             badge: badge, now: clock()) else { return observations }
                do {
                    try next.writeUnlocked(root: root)
                    observations.append(event(.writeSucceeded))
                } catch { observations.append(event(.writeFailed)) }
                return observations
            }
        } catch { return [event(.writeFailed)] }
        guard events.contains(where: { $0.decision == .writeSucceeded }) else { return events }
        let requestedAt = clock().timeIntervalSince1970
        let requested = reload()
        events.append(PushEvent(decision: requested ? .reloadRequested : .reloadUnavailable, time: requestedAt))
        return events
    }

    private static func requestReload() -> Bool {
        #if os(iOS) && canImport(WidgetKit)
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
            return true
        }
        #endif
        return false
    }
}

extension UnreadList {
    /// The next `count` midnights after `date`: the moments a time label turns into "Yesterday", then a weekday.
    static func midnights(after date: Date, count: Int = 7, calendar: Calendar = .current) -> [Date] {
        let start = calendar.startOfDay(for: date)
        return (1...count).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
    }

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
