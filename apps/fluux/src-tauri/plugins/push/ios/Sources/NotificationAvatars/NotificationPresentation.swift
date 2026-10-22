import Foundation
import UserNotifications
import Intents

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
    static func belongsToSignedInAccount(_ content: UNNotificationContent, names: SharedNames) -> Bool {
        guard let account = names.account, bareJid(account) == account else { return false }
        guard let value = content.userInfo["to"] else { return true }
        guard let recipient = value as? String, let bare = bareJid(recipient) else { return false }
        return bare == account
    }

    /// A room sends each groupchat message back to every resource of its sender, so a message
    /// the user posts from another client can reach this device as a push.
    static func isOwnRoomMessage(_ content: UNNotificationContent, names: SharedNames) -> Bool {
        guard let from = content.userInfo["from"] as? String, let bare = bareJid(from), names.rooms[bare] != nil,
              let nick = from.split(separator: "/", maxSplits: 1).dropFirst().first.map(String.init),
              let participants = names.roomParticipants[bare] else { return false }
        return nick == participants.ownNick
    }

    /// The user's own message, delivered without sound, badge or banner. Suppressing it needs
    /// Apple's notification-filtering entitlement.
    static func ownMessageContent(_ original: UNNotificationContent, names: SharedNames) -> UNNotificationContent {
        guard let content = original.mutableCopy() as? UNMutableNotificationContent else { return original }
        if let from = content.userInfo["from"] as? String {
            let sender = SenderTitle(from: from, names: names)
            content.title = sender.title
            if let subtitle = sender.subtitle { content.subtitle = subtitle }
            if content.threadIdentifier.isEmpty, let bare = bareJid(from) { content.threadIdentifier = bare }
        }
        content.sound = nil
        content.badge = nil
        content.interruptionLevel = .passive
        content.relevanceScore = 0
        return content
    }

    static func neutralContent() -> UNNotificationContent {
        // Empty content needs Apple's notification-filtering entitlement to suppress an alert.
        let content = UNMutableNotificationContent()
        content.title = "Fluux"
        content.body = PreviewWords.localized.activity
        return content
    }

    /// The conversation a delivered notification belongs to: the `navTarget` the app
    /// gives its own notifications (the notification plugin keeps `extra` under
    /// `__EXTRA__`), or the bare JID a push comes from. A push whose `from` is not a
    /// JID with a local part belongs to none.
    static func conversation(of userInfo: [AnyHashable: Any]) -> String? {
        if let extra = userInfo["__EXTRA__"] as? [String: Any], let target = extra["navTarget"] as? String {
            return target.lowercased()
        }
        return (userInfo["from"] as? String).flatMap(bareJid)?.lowercased()
    }

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
        let destination = names.account.flatMap { account -> String? in
            let destination = ConversationDestination(account: account, jid: bare, type: room == nil ? "chat" : "groupchat")
            return destination.belongs(to: names) ? destination.identifier : nil
        }
        var recipients: [INPerson]?
        if room != nil, let participants = names.roomParticipants[bare], let nick = nick,
           participants.nicks.contains(nick), participants.nicks.contains(participants.ownNick) {
            // Apple's incoming communication contract already represents the sender and current user.
            // Use the full last-known occupancy; an unknown sender leaves the existing fallback intact.
            recipients = participants.nicks.filter { $0 != nick && $0 != participants.ownNick }.map { recipient in
                INPerson(personHandle: INPersonHandle(value: bare + "/" + recipient, type: .unknown),
                         nameComponents: nil, displayName: recipient, image: nil,
                         contactIdentifier: nil, customIdentifier: nil)
            }
        }
        let intent = INSendMessageIntent(recipients: recipients, outgoingMessageType: .outgoingMessageText,
                                         content: body, speakableGroupName: room.map { INSpeakableString(spokenPhrase: $0) },
                                         conversationIdentifier: destination, serviceName: nil, sender: sender, attachments: nil)
        #if os(iOS)
        if room != nil, let image = image { intent.setImage(image, forParameterNamed: \.speakableGroupName) }
        #endif
        return intent
    }

    static func content(for original: UNNotificationContent, names: SharedNames = SharedNames.load()) -> UNNotificationContent {
        guard let content = original.mutableCopy() as? UNMutableNotificationContent else { return original }
        content.body = NotificationContent.transportBody(content.body, encrypted: content.userInfo["encrypted"] as? Bool,
                                                        activity: PreviewWords.localized.activity)
        guard let from = content.userInfo["from"] as? String else { return content }
        if content.threadIdentifier.isEmpty, let bare = bareJid(from) { content.threadIdentifier = bare }
        if let settings = NotificationSoundSettings.load(root: NotificationMirror.root), settings.account != nil, settings.account == names.account {
            let sound = settings.soundName(originalHasSound: content.sound != nil, owner: names.account)
            content.sound = sound.map { $0 == "default" ? .default : UNNotificationSound(named: UNNotificationSoundName(rawValue: $0)) }
        }
        let sender = SenderTitle(from: from, names: names)
        content.title = sender.title
        if let subtitle = sender.subtitle { content.subtitle = subtitle }
        if var badge = SharedBadge.load() { content.badge = NSNumber(value: badge.count(adding: from, rooms: names.rooms)) }
        #if os(iOS)
        if #available(iOS 15.0, *), let intent = intent(from: from, body: content.body, names: names) {
            let interaction = INInteraction(intent: intent, response: nil)
            interaction.direction = .incoming
            if let id = intent.conversationIdentifier {
                interaction.groupIdentifier = id
                interaction.donate(completion: nil)
            }
            if let updated = try? content.updating(from: intent).mutableCopy() as? UNMutableNotificationContent {
                // Preserve the server's grouping id and the app's badge across the system update.
                updated.threadIdentifier = content.threadIdentifier
                updated.badge = content.badge
                updated.sound = content.sound
                updated.userInfo = content.userInfo
                return updated
            }
        }
        #endif
        return content
    }
}
