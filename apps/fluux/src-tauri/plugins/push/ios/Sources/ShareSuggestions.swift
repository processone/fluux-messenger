import Foundation
import Intents

/// Serializes donation and deletion so a late system callback cannot resurrect removed suggestions.
enum ShareSuggestions {
    private static let queue = DispatchQueue(label: "fluux.share-suggestions")
    private static var jobs: [(@escaping () -> Void) -> Void] = []
    private static var running = false

    private static func enqueue(_ work: @escaping (@escaping () -> Void) -> Void) {
        queue.async { jobs.append(work); next() }
    }
    private static func next() {
        guard !running, !jobs.isEmpty else { return }
        running = true
        let work = jobs.removeFirst()
        work { queue.async { running = false; next() } }
    }

    static func update(_ input: SharedNames, root: URL, completion: @escaping (Error?) -> Void) {
        enqueue { finished in
            let old = SharedNames.load(root: root)
            let retained = input.preserveIfEmpty && old.account == input.account && input.contacts.isEmpty && input.rooms.isEmpty
                ? old : input
            let removed = ConversationDestination.obsoleteIdentifiers(in: old, keeping: retained)
            func write(_ error: Error?) {
                queue.async {
                    do {
                        // Removal invalidates the native account index even when the system deletion fails.
                        try NotificationMirror.writeNames(input, root: root)
                        completion(error)
                    } catch { completion(error) }
                    finished()
                }
            }
            var firstError: Error?
            func remove(_ remaining: ArraySlice<String>) {
                guard let id = remaining.first else { write(firstError); return }
                INInteraction.delete(with: id) { error in
                    if firstError == nil { firstError = error }
                    remove(remaining.dropFirst())
                }
            }
            let version = root.appendingPathComponent("ShareSuggestionVersion")
            if old.account == nil || !FileManager.default.fileExists(atPath: version.path) {
                // The legacy format has no account ownership; clear it before enabling suggestions.
                INInteraction.deleteAll { error in
                    if error == nil { try? Data("1".utf8).write(to: version, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
                    write(error)
                }
            } else { remove(removed[...]) }
        }
    }

    static func remove(_ destination: ConversationDestination, completion: @escaping (Error?) -> Void) {
        enqueue { finished in
            guard let id = destination.identifier else { completion(nil); finished(); return }
            INInteraction.delete(with: id) { error in completion(error); finished() }
        }
    }

    static func donate(_ destination: ConversationDestination, root: URL, completion: @escaping (Error?) -> Void) {
        enqueue { finished in
            let names = SharedNames.load(root: root)
            guard destination.belongs(to: names), let id = destination.identifier else {
                completion(nil); finished(); return
            }
            let room = destination.type == "groupchat"
            let name = (room ? names.rooms : names.contacts)[destination.jid] ?? destination.jid
            let recipient = INPerson(personHandle: INPersonHandle(value: destination.jid, type: .unknown),
                                     nameComponents: nil, displayName: name, image: nil,
                                     contactIdentifier: nil, customIdentifier: id)
            let intent = INSendMessageIntent(recipients: [recipient], outgoingMessageType: .outgoingMessageText,
                                             content: nil, speakableGroupName: room ? INSpeakableString(spokenPhrase: name) : nil,
                                             conversationIdentifier: id, serviceName: nil, sender: nil, attachments: nil)
            if let url = NotificationMirror.imageURL(for: destination.jid, names: names, root: root),
               let data = try? Data(contentsOf: url) {
                if room { intent.setImage(INImage(imageData: data), forParameterNamed: \.speakableGroupName) }
                else { intent.setImage(INImage(imageData: data), forParameterNamed: \.recipients) }
            }
            let interaction = INInteraction(intent: intent, response: nil)
            interaction.direction = .outgoing
            interaction.groupIdentifier = id
            interaction.donate { error in completion(error); finished() }
        }
    }
}
