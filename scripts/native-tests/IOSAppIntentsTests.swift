import Foundation

@main struct IOSAppIntentsTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let chat = ShortcutConversation(id: "friend@example.com", name: "Friend", kind: "chat", account: "me@example.com")
        let room = ShortcutConversation(id: "team@example.com", name: "Team", kind: "groupchat", account: "me@example.com")
        let stale = ShortcutConversation(id: chat.id, name: "Private", kind: "chat", account: "old@example.com")
        var names = SharedNames(account: chat.account)
        names.conversations = [chat, room, stale]
        try NotificationMirror.writeNames(names, root: root)
        let stored = SharedNames.load(root: root)
        precondition(stored.conversations == [chat, room], "Mirror must reject entries owned by another account")
        precondition(ShortcutConversation.available(in: stored) == [chat, room])
        let url = URLComponents(url: chat.url(scheme: "net.processone.fluux")!, resolvingAgainstBaseURL: false)!
        precondition(url.host == "shortcut")
        precondition(url.queryItems!.contains(URLQueryItem(name: "account", value: chat.account)))
        precondition(url.queryItems!.contains(URLQueryItem(name: "id", value: chat.id)))
        let plus = ShortcutConversation(id: "friend+work@example.com", name: "Friend", kind: "chat", account: "me+work@example.com")
        precondition(plus.url(scheme: "net.processone.fluux")!.absoluteString.contains("me%2Bwork"))
        precondition(plus.url(scheme: "net.processone.fluux")!.absoluteString.contains("friend%2Bwork"))
        precondition(chat.destination.identifier != stale.destination.identifier, "Saved entity identifiers must include the owning account")
        let saved = ShortcutConversation.resolve(identifiers: [chat.destination.identifier!, "invalid"], in: SharedNames())
        precondition(saved.count == 1 && saved[0].account == chat.account, "Stale saved shortcuts open the app for live account validation")
        let legacy = try JSONDecoder().decode(SharedNames.self, from: Data("{\"account\":\"me@example.com\"}".utf8))
        precondition(legacy.conversations.isEmpty, "Existing mirrors must remain readable")
        var pending = SharedNames(account: chat.account)
        pending.preserveIfEmpty = true
        try NotificationMirror.writeNames(pending, root: root)
        precondition(SharedNames.load(root: root).conversations == [chat, room], "Same-account hydration preserves the mirror")
        try NotificationMirror.writeNames(SharedNames(account: "next@example.com"), root: root)
        precondition(SharedNames.load(root: root).conversations.isEmpty, "Switch must clear old destinations")
        try NotificationMirror.writeNames(names, root: root)
        try NotificationMirror.writeNames(SharedNames(), root: root)
        precondition(SharedNames.load(root: root).conversations.isEmpty, "Logout must clear destinations")
        precondition(SharedBadge.load(root: root) == nil)
        let badge = SharedBadge(unread: [chat.id, room.id], events: 3, notifyAllRooms: [])
        try JSONEncoder().encode(badge).write(to: root.appendingPathComponent("NotificationBadge.json"))
        precondition(SharedBadge.load(root: root)?.count == 5, "Siri must read the icon badge snapshot, including pending events")
        try Data("invalid".utf8).write(to: root.appendingPathComponent("NotificationBadge.json"))
        precondition(SharedBadge.load(root: root) == nil)
        print("iOS App Intents contracts passed")
    }
}
