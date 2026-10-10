import Foundation
@main struct IOSQuickWinsTests {
    static func main() throws {
        let owner = "me@example.com"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for tone in NotificationSoundSettings.tones {
            let settings = NotificationSoundSettings(account: owner, enabled: true, tone: tone)
            try settings.write(root: root)
            let loaded = NotificationSoundSettings.load(root: root)!
            precondition(loaded.soundName(originalHasSound: true, owner: owner) == (tone == "silent" ? nil : tone == "default" ? "default" : "fluux-\(tone).wav"))
            precondition(loaded.soundName(originalHasSound: false, owner: owner) == nil)
            precondition(loaded.soundName(originalHasSound: true, owner: "other@example.com") == nil)
        }
        precondition(NotificationSoundSettings(account: owner, enabled: false, tone: "bell").soundName(originalHasSound: true, owner: owner) == nil)
        let destination = ConversationDestination(account: owner, jid: "friend@example.com", type: "chat")
        precondition(ConversationDestination.decode(destination.identifier) == destination)
        precondition(destination.identifier != ConversationDestination(account: "other@example.com", jid: destination.jid, type: "chat").identifier)
        precondition(destination.identifier != ConversationDestination(account: owner, jid: destination.jid, type: "groupchat").identifier)
        precondition(ConversationDestination.decode("friend@example.com") == nil)
        precondition(ConversationDestination(account: owner, jid: "bad/../../", type: "chat").identifier == nil)
        let names = SharedNames(contacts: [destination.jid: "Friend"], account: owner)
        precondition(destination.belongs(to: names))
        precondition(!destination.belongs(to: SharedNames(contacts: names.contacts, account: "other@example.com")))
        precondition(!destination.belongs(to: SharedNames(account: owner)))
        precondition(ConversationDestination.obsoleteIdentifiers(in: names, keeping: names).isEmpty)
        precondition(ConversationDestination.obsoleteIdentifiers(in: names, keeping: SharedNames(account: owner)) == [destination.identifier!])
        precondition(ConversationDestination.obsoleteIdentifiers(in: names, keeping: SharedNames(contacts: names.contacts, account: "other@example.com")) == [destination.identifier!])
        let room = ConversationDestination(account: owner, jid: "room@conference.example.com", type: "groupchat")
        let roomNames = SharedNames(rooms: [room.jid: "Team"], account: owner)
        precondition(room.belongs(to: roomNames))
        precondition(ConversationDestination.obsoleteIdentifiers(in: roomNames, keeping: SharedNames(account: owner)) == [room.identifier!])
        precondition(ConversationDestination.obsoleteIdentifiers(in: roomNames, keeping: SharedNames()) == [room.identifier!])
        print("iOS quick wins passed")
    }
}
