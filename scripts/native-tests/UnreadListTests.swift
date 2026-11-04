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
