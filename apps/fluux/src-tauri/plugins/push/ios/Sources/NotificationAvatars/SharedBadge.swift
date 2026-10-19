import Foundation

/// What the app icon badge counts, as the push plugin writes it. The badge is
/// `unread.count + events`, the same count the app shows.
///
/// A push adds its conversation to `unread`, once. A room counts only when
/// every message in it does (`notifyAllRooms`): otherwise only a mention does,
/// which the push does not reveal. The app puts its own count back when it
/// becomes active.
struct SharedBadge: Codable {
    var unread: [String]
    var events: Int
    var notifyAllRooms: [String]

    static func load(root: URL? = NotificationMirror.root) -> SharedBadge? {
        guard let url = root?.appendingPathComponent("NotificationBadge.json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SharedBadge.self, from: data)
    }

    var count: Int { unread.count + events }

    mutating func count(adding from: String, rooms: [String: String]) -> Int {
        let bare = from.split(separator: "/", maxSplits: 1).first.map(String.init) ?? from
        let isRoom = rooms[bare] != nil || notifyAllRooms.contains(bare)
        if !unread.contains(bare) && (!isRoom || notifyAllRooms.contains(bare)) {
            unread.append(bare)
            if let url = sharedFile("NotificationBadge.json"), let data = try? JSONEncoder().encode(self) {
                try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
        return count
    }
}

private func sharedFile(_ name: String) -> URL? {
    guard let root = NotificationMirror.root else {
        return nil
    }
    return root.appendingPathComponent(name)
}
