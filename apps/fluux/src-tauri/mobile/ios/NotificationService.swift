import Foundation
import UserNotifications

/// Titles a remote notification with the name of its sender, and sets the app
/// icon badge.
///
/// The push app server knows the sender only by the JID in `from`: a contact's
/// bare JID, or a room JID with the occupant's nick as resource. The names come
/// from the roster and the rooms, which the app shares through the app group in
/// `NotificationNames.json` (written by the push plugin), since an extension
/// cannot reach the app's storage nor the XMPP server.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
              let from = content.userInfo["from"] as? String else {
            contentHandler(request.content)
            return
        }
        let names = SharedNames.load()
        let sender = SenderTitle(from: from, names: names)
        content.title = sender.title
        if let subtitle = sender.subtitle {
            content.subtitle = subtitle
        }
        if var badge = SharedBadge.load() {
            content.badge = NSNumber(value: badge.count(adding: from, rooms: names.rooms))
        }
        contentHandler(content)
    }
}

/// `{"contacts": {bareJid: name}, "rooms": {roomJid: name}}`, as the push plugin writes it.
struct SharedNames: Decodable {
    var contacts: [String: String] = [:]
    var rooms: [String: String] = [:]

    static func load() -> SharedNames {
        guard let url = sharedFile("NotificationNames.json"),
              let data = try? Data(contentsOf: url),
              let names = try? JSONDecoder().decode(SharedNames.self, from: data) else {
            return SharedNames()
        }
        return names
    }
}

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

    static func load() -> SharedBadge? {
        guard let url = sharedFile("NotificationBadge.json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SharedBadge.self, from: data)
    }

    mutating func count(adding from: String, rooms: [String: String]) -> Int {
        let bare = from.split(separator: "/", maxSplits: 1).first.map(String.init) ?? from
        let isRoom = rooms[bare] != nil || notifyAllRooms.contains(bare)
        if !unread.contains(bare) && (!isRoom || notifyAllRooms.contains(bare)) {
            unread.append(bare)
            if let url = sharedFile("NotificationBadge.json"), let data = try? JSONEncoder().encode(self) {
                try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
        return unread.count + events
    }
}

private func sharedFile(_ name: String) -> URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String,
          let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
        return nil
    }
    return root.appendingPathComponent(name)
}

struct SenderTitle {
    let title: String
    let subtitle: String?

    /// A room shows its name over the occupant's nick; a contact, its name. An
    /// unknown sender shows the local part of its JID.
    init(from: String, names: SharedNames) {
        let parts = from.split(separator: "/", maxSplits: 1).map(String.init)
        let bare = parts.first ?? from
        let resource = parts.count > 1 && !parts[1].isEmpty ? parts[1] : nil
        if let room = names.rooms[bare] {
            title = room
            subtitle = resource
        } else if let contact = names.contacts[bare] {
            title = contact
            subtitle = nil
        } else {
            title = bare.split(separator: "@", maxSplits: 1).first.map(String.init) ?? bare
            subtitle = resource
        }
    }
}
