import Foundation
import UserNotifications

/// Titles a remote notification with the name of its sender.
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
        let sender = SenderTitle(from: from, names: SharedNames.load())
        content.title = sender.title
        if let subtitle = sender.subtitle {
            content.subtitle = subtitle
        }
        contentHandler(content)
    }
}

/// `{"contacts": {bareJid: name}, "rooms": {roomJid: name}}`, as the push plugin writes it.
struct SharedNames: Decodable {
    var contacts: [String: String] = [:]
    var rooms: [String: String] = [:]

    static func load() -> SharedNames {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let data = try? Data(contentsOf: root.appendingPathComponent("NotificationNames.json")),
              let names = try? JSONDecoder().decode(SharedNames.self, from: data) else {
            return SharedNames()
        }
        return names
    }
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
