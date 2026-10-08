import Foundation
import UserNotifications
import Intents

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
    guard let root = NotificationMirror.root else {
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

/// Builds communication metadata without changing the APNs payload or conversation routing.
enum NotificationPresentation {
    static func bareJid(_ from: String) -> String? {
        let bare = String(from.prefix { $0 != "/" })
        let parts = bare.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, parts.allSatisfy({ !$0.isEmpty }),
              bare.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }
        return bare
    }

    static func intent(from: String, body: String, names: SharedNames, root: URL? = NotificationMirror.root) -> INSendMessageIntent? {
        guard let bare = bareJid(from) else { return nil }
        let title = SenderTitle(from: from, names: names)
        let room = names.rooms[bare]
        let nick = from.split(separator: "/", maxSplits: 1).dropFirst().first.map(String.init)
        let image = NotificationMirror.imageURL(for: bare, names: names, root: root).flatMap { url -> INImage? in
            guard let data = try? Data(contentsOf: url), NotificationMirror.thumbnail(data) != nil else { return nil }
            return INImage(imageData: data)
        }
        // A room image describes the conversation, never the occupant who sent the message.
        let senderName = room.map { nick ?? $0 } ?? title.title
        let sender = INPerson(personHandle: INPersonHandle(value: room == nil ? bare : from, type: .unknown),
                              nameComponents: nil, displayName: senderName,
                              image: room == nil ? image : nil, contactIdentifier: nil, customIdentifier: nil)
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                         content: body, speakableGroupName: room.map { INSpeakableString(spokenPhrase: $0) },
                                         conversationIdentifier: bare, serviceName: nil, sender: sender, attachments: nil)
        #if os(iOS)
        if room != nil, let image = image { intent.setImage(image, forParameterNamed: \.speakableGroupName) }
        #endif
        return intent
    }

    static func content(for original: UNNotificationContent) -> UNNotificationContent {
        guard let content = original.mutableCopy() as? UNMutableNotificationContent,
              let from = content.userInfo["from"] as? String else { return original }
        if content.threadIdentifier.isEmpty, let bare = bareJid(from) { content.threadIdentifier = bare }
        let names = SharedNames.load()
        let sender = SenderTitle(from: from, names: names)
        content.title = sender.title
        if let subtitle = sender.subtitle { content.subtitle = subtitle }
        if var badge = SharedBadge.load() { content.badge = NSNumber(value: badge.count(adding: from, rooms: names.rooms)) }
        #if os(iOS)
        if #available(iOS 15.0, *), let intent = intent(from: from, body: content.body, names: names) {
            let interaction = INInteraction(intent: intent, response: nil)
            interaction.direction = .incoming
            interaction.donate(completion: nil)
            if let updated = try? content.updating(from: intent).mutableCopy() as? UNMutableNotificationContent {
                // Preserve the server's grouping id and the app's badge across the system update.
                updated.threadIdentifier = content.threadIdentifier
                updated.badge = content.badge
                return updated
            }
        }
        #endif
        return content
    }
}
