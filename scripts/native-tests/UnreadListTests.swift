import Foundation
import UserNotifications

/// The widget's unread list, the notification extension's hook that adds a pushed conversation,
/// and the file the widget reads, in a scratch folder standing in for the App Group.
@main struct CheckUnreadList {
    static let account = "me@example.com"

    static func fixture() -> UnreadList {
        UnreadList(account: account, total: 3, rows: [
            .init(id: "alice@example.com", kind: "chat", name: "Alice Martin", unread: 2, mentions: 0, last: 1_793_000_000_000),
            .init(id: "dev@conference.example.com", kind: "groupchat", name: "ejabberd-dev", unread: 14, mentions: 1, last: 1_792_999_000_000),
        ], updated: 1_793_000_000_000)
    }

    static func scratch() -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    static func push(_ from: String, names: SharedNames, badge: SharedBadge, root: URL) -> Int? {
        let content = UNMutableNotificationContent()
        content.userInfo = ["from": from, "to": account]
        var total: Int?
        _ = NotificationPresentation.content(for: content, names: names, badge: badge) { bare, isRoom, count in
            total = count
            UnreadList.recordPush(conversation: bare, kind: isRoom ? "groupchat" : "chat",
                                  name: (isRoom ? names.rooms[bare] : names.contacts[bare]) ?? bare,
                                  account: names.account, total: count, root: root)
        }
        return total
    }

    static func main() throws {
        let root = scratch()
        defer { try? FileManager.default.removeItem(at: root) }
        let names = SharedNames(contacts: ["bruno@example.com": "Bruno Roux"],
                                rooms: ["quiet@conference.example.com": "Quiet", "all@conference.example.com": "Release team"],
                                account: account)
        let badge = SharedBadge(unread: ["alice@example.com", "dev@conference.example.com"], events: 1,
                                notifyAllRooms: ["all@conference.example.com"])
        switch CommandLine.arguments[1] {
        case "round-trip":
            try fixture().write(root: root)
            precondition(UnreadList.load(root: root) == fixture(), "The list must read back as written")
            try Data("{not json".utf8).write(to: root.appendingPathComponent(UnreadList.fileName))
            precondition(UnreadList.load(root: root) == nil, "A corrupt file shows nothing")
            precondition(UnreadList.load(root: nil) == nil)
        case "no-message-text":
            try fixture().write(root: root)
            let object = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(UnreadList.fileName))) as! [String: Any]
            let rows = object["rows"] as! [[String: Any]]
            precondition(Set(rows.flatMap { $0.keys }) == ["id", "kind", "name", "unread", "mentions", "last"], "A row holds no message text")
            precondition(Set(object.keys) == ["account", "total", "rows", "updated"])
        case "push-adds-row":
            try fixture().write(root: root)
            let total = push("bruno@example.com/phone", names: names, badge: badge, root: root)
            precondition(total == 4, "The badge rises to 4, got \(String(describing: total))")
            let list = UnreadList.load(root: root)!
            precondition(list.rows.map(\.id) == ["bruno@example.com", "alice@example.com", "dev@conference.example.com"])
            precondition(list.rows[0].name == "Bruno Roux" && list.rows[0].kind == "chat" && list.total == 4)
            // The badge already counts a conversation it lists: a second push changes nothing.
            let before = try Data(contentsOf: root.appendingPathComponent(UnreadList.fileName))
            var counted = badge
            counted.unread.append("bruno@example.com")
            precondition(push("bruno@example.com/phone", names: names, badge: counted, root: root) == nil)
            let after = try Data(contentsOf: root.appendingPathComponent(UnreadList.fileName))
            precondition(after == before)
        case "push-events":
            var reloads = 0
            var tick: TimeInterval = 0
            let clock = { tick += 1; return Date(timeIntervalSince1970: tick) }
            func record(_ owner: String? = account, conversation: String = "new@example.com", at folder: URL) -> [UnreadList.PushEvent] {
                UnreadList.recordPush(conversation: conversation, kind: "chat", name: "Private name", account: owner,
                                      total: 4, root: folder, clock: clock, reload: { reloads += 1; return true })
            }
            precondition(record(at: root).map(\.decision) == [.listUnavailable])
            try fixture().write(root: root)
            precondition(record("other@example.com", at: root).map(\.decision) == [.accountMismatch])
            precondition(record(conversation: "alice@example.com", at: root).map(\.decision) == [.alreadyListed])
            precondition(reloads == 0, "A skipped write must never request a reload")
            let events = record(at: root)
            precondition(events.map(\.decision) == [.rowSelected, .writeSucceeded, .reloadRequested])
            precondition(zip(events, events.dropFirst()).allSatisfy { $0.time < $1.time }, "Keep each operation's original timestamp")
            precondition(UnreadList.load(root: root)!.rows.first?.id == "new@example.com" && reloads == 1)
            let unavailable = UnreadList.recordPush(conversation: "next@example.com", kind: "chat", name: "Next",
                                                     account: account, total: 5, root: root, reload: { false })
            precondition(unavailable.map(\.decision) == [.rowSelected, .writeSucceeded, .reloadUnavailable])
        case "write-failure":
            try fixture().write(root: root)
            let before = try Data(contentsOf: root.appendingPathComponent(UnreadList.fileName))
            // Exercise a real filesystem refusal, not a writer that merely returns a canned error.
            precondition(geteuid() != 0, "This fixture needs an unprivileged process")
            try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: root.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path) }
            var reloads = 0
            let events = UnreadList.recordPush(conversation: "new@example.com", kind: "chat", name: "Private name",
                                               account: account, total: 4, root: root, reload: { reloads += 1; return true })
            precondition(events.map(\.decision) == [.rowSelected, .writeFailed] && reloads == 0)
            let after = try Data(contentsOf: root.appendingPathComponent(UnreadList.fileName))
            precondition(after == before, "The failed write must leave the existing list unchanged")
        case "room-rule":
            try fixture().write(root: root)
            // A room outside notify-all counts only on a mention, which a push does not reveal.
            precondition(push("quiet@conference.example.com/bob", names: names, badge: badge, root: root) == nil)
            precondition(UnreadList.load(root: root)! == fixture(), "A quiet room adds no row")
            precondition(push("all@conference.example.com/bob", names: names, badge: badge, root: root) == 4)
            let row = UnreadList.load(root: root)!.rows[0]
            precondition(row.id == "all@conference.example.com" && row.kind == "groupchat" && row.name == "Release team")
        case "other-account":
            var other = fixture()
            other.account = "old@example.com"
            try other.write(root: root)
            _ = push("bruno@example.com/phone", names: names, badge: badge, root: root)
            precondition(UnreadList.load(root: root)! == other, "Another account's list stays as it is")
            try UnreadList.clear(root: root)
            _ = push("bruno@example.com/phone", names: names, badge: badge, root: root)
            precondition(UnreadList.load(root: root) == nil, "Nothing is listed after sign-out")
        case "cap":
            var full = fixture()
            full.rows = (0..<UnreadList.maxRows).map { .init(id: "c\($0)@example.com", kind: "chat", name: "C\($0)", unread: 1, mentions: 0, last: 1) }
            let next = full.adding("new@example.com", kind: "chat", name: "New", account: account, total: 99)!
            precondition(next.rows.count == UnreadList.maxRows && next.rows[0].id == "new@example.com" && next.total == 99)
        case "concurrent-pushes":
            // FLM-418 R2: overlapping read-modify-write changes must not lose a row.
            var list = fixture()
            list.rows = []
            try list.write(root: root)
            DispatchQueue.concurrentPerform(iterations: 10) { index in
                UnreadList.recordPush(conversation: "c\(index)@example.com", kind: "chat", name: "C\(index)",
                                      account: account, total: index, root: root)
            }
            precondition(Set(UnreadList.load(root: root)!.rows.map(\.id)).count == 10, "No push may lose another's row")
        case "latest-total-wins":
            // FLM-418 R2: the badge is read under the list's lock, so the last writer leaves the newest total.
            var list = fixture()
            list.rows = []
            try list.write(root: root)
            let lock = NSLock()
            var badge = 0
            DispatchQueue.concurrentPerform(iterations: 10) { index in
                lock.lock(); badge = max(badge, index + 1); lock.unlock()
                UnreadList.recordPush(conversation: "c\(index)@example.com", kind: "chat", name: "C\(index)",
                                      account: account, total: { lock.lock(); defer { lock.unlock() }; return badge }(), root: root)
            }
            precondition(UnreadList.load(root: root)!.total == 10, "The newest total must survive")
        case "labels-follow-entry-date":
            // FLM-418 R5: labels are relative to the entry's date, not the real clock.
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "UTC")!
            let locale = Locale(identifier: "en_US")
            let message = Date(timeIntervalSince1970: 1_793_000_000) // 2026-10-26 07:33 UTC
            let sameDay = message.addingTimeInterval(3600)
            let nextDay = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: message))!
            let inThree = calendar.date(byAdding: .day, value: 3, to: calendar.startOfDay(for: message))!
            let inTen = calendar.date(byAdding: .day, value: 10, to: calendar.startOfDay(for: message))!
            let today = UnreadList.when(message, now: sameDay, calendar: calendar, locale: locale)
            precondition(today.contains(":"), "Today shows a time, got \(today)")
            precondition(UnreadList.when(message, now: nextDay, calendar: calendar, locale: locale) == "Yesterday")
            precondition(UnreadList.when(message, now: inThree, calendar: calendar, locale: locale) == "Mon")
            precondition(!UnreadList.when(message, now: inTen, calendar: calendar, locale: locale).contains(":"))
            precondition(UnreadList.when(message, now: nextDay, calendar: calendar, locale: Locale(identifier: "fr_FR")) == "Hier")
        case "mismatched-owner":
            // FLM-418 R8: a list ahead of the names is hidden and asks for another look; a match shows it.
            try fixture().write(root: root)
            var result = UnreadList.shown(root: root, account: nil)
            precondition(result.list == nil && result.awaitingAccount, "Names that have not caught up hide the list and retry")
            result = UnreadList.shown(root: root, account: "other@example.com")
            precondition(result.list == nil && result.awaitingAccount, "Another account's list is hidden")
            result = UnreadList.shown(root: root, account: account)
            precondition(result.list != nil && !result.awaitingAccount, "The confirmed account's list shows")
            try UnreadList.clear(root: root)
            result = UnreadList.shown(root: root, account: nil)
            precondition(result.list == nil && !result.awaitingAccount, "A signed-out app with no list has nothing to wait for")
        case "midnights":
            // FLM-418 R5: one timeline entry per coming midnight, across a daylight-saving change.
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "Europe/Paris")!
            let evening = calendar.date(from: DateComponents(year: 2026, month: 10, day: 24, hour: 23, minute: 30))!
            let dates = UnreadList.midnights(after: evening, count: 7, calendar: calendar)
            precondition(dates.count == 7)
            for (index, date) in dates.enumerated() {
                let parts = calendar.dateComponents([.hour, .minute, .day], from: date)
                precondition(parts.hour == 0 && parts.minute == 0, "Entry \(index) must fall on a midnight")
                precondition(parts.day == 25 + index, "Entry \(index) is on day \(25 + index)")
            }
            precondition(dates[0] > evening && dates[0].timeIntervalSince(evening) == 1800, "The first midnight is the next one")
            precondition(zip(dates, dates.dropFirst()).allSatisfy { calendar.isDate($1, inSameDayAs: calendar.date(byAdding: .day, value: 1, to: $0)!) })
        case "clear-wins":
            try fixture().write(root: root)
            try UnreadList.clear(root: root)
            UnreadList.recordPush(conversation: "late@example.com", kind: "chat", name: "Late", account: account, total: 1, root: root)
            precondition(UnreadList.load(root: root) == nil, "A push after the clear must not bring the list back")
        case "clear":
            try fixture().write(root: root)
            try UnreadList.clear(root: root)
            try UnreadList.clear(root: root)
            precondition(UnreadList.load(root: root) == nil)
        default:
            preconditionFailure("unknown scenario")
        }
        print("\(CommandLine.arguments[1]) passed")
    }
}
