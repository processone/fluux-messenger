import Foundation
import UserNotifications
import Intents
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

@main struct CheckNotifications {
    static func check(from: Any? = nil, existing: String = "", expected: String) {
        let content = UNMutableNotificationContent()
        content.threadIdentifier = existing
        content.userInfo = ["to": "fixture@example.com"]
        if let from = from { content.userInfo["from"] = from }
        let request = UNNotificationRequest(identifier: "fixture", content: content, trigger: nil)
        var delivered = false
        let service = NotificationService()
        service.loadNames = { SharedNames(account: "fixture@example.com") }
        service.didReceive(request) { result in
            precondition(result.threadIdentifier == expected,
                         "Expected thread '\(expected)', got '\(result.threadIdentifier)'")
            delivered = true
        }
        precondition(delivered, "The extension must deliver the notification")
        precondition(request.content.threadIdentifier == existing, "The request must remain unchanged")
    }

    static func accountGuard() {
        let content = UNMutableNotificationContent()
        content.title = "Private sender"
        content.subtitle = "Private room"
        content.body = "Private message"
        content.sound = .default
        content.badge = 9
        content.threadIdentifier = "private-thread"
        content.userInfo = ["from": "alice@example.com", "to": "old@example.com"]
        for recipient: Any? in [nil, 42, "", "invalid", "old@example.com", "next@example.com/phone"] {
            content.userInfo["to"] = recipient
            let service = NotificationService()
            service.loadNames = { SharedNames(account: "next@example.com") }
            var delivered = false
            service.didReceive(UNNotificationRequest(identifier: "guard", content: content, trigger: nil)) { result in
                if recipient == nil || recipient as? String == "next@example.com/phone" {
                    precondition(result.body == "Private message", "A matching account must retain its push")
                    precondition(result.threadIdentifier == "private-thread")
                    precondition(result.userInfo["from"] as? String == "alice@example.com")
                    precondition(result.sound != nil)
                } else {
                    precondition(result.title == "Fluux" && result.body != "Private message" && !result.body.isEmpty)
                    precondition(result.subtitle.isEmpty && result.userInfo.isEmpty && result.attachments.isEmpty)
                    precondition(result.sound == nil && result.badge == nil && result.threadIdentifier.isEmpty)
                }
                delivered = true
            }
            precondition(delivered)
        }
        content.userInfo["to"] = "old@example.com"
        let service = NotificationService()
        var reads = 0
        service.loadNames = {
            reads += 1
            return SharedNames(account: reads == 1 ? "old@example.com" : nil)
        }
        var delivered = false
        service.didReceive(UNNotificationRequest(identifier: "revoked-during-delivery", content: content, trigger: nil)) { result in
            precondition(result.body != "Private message", "Logout before handoff must revoke content")
            delivered = true
        }
        precondition(delivered)
    }

    static func stalledMirrorCleanup() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try NotificationMirror.writeNames(SharedNames(contacts: ["alice@example.com": "Alice"], account: "old@example.com"), root: root)
        let entered = DispatchSemaphore(value: 0)
        ShareSuggestions.update(SharedNames(), root: root, deleteAll: { _ in entered.signal() }, delete: { _, _ in entered.signal() }) { _ in
            preconditionFailure("The fixture's system callback must remain stalled")
        }
        precondition(entered.wait(timeout: .now() + 2) == .success)
        precondition(SharedNames.load(root: root).account == nil, "Logout must revoke ownership before suggestion callbacks")
        let content = UNMutableNotificationContent()
        content.body = "Private message"
        content.userInfo = ["to": "old@example.com", "from": "alice@example.com"]
        let service = NotificationService()
        service.loadNames = { SharedNames.load(root: root) }
        service.didReceive(UNNotificationRequest(identifier: "stalled-cleanup", content: content, trigger: nil)) { result in
            precondition(result.body != "Private message")
        }
    }

    /// FLM-418 R8: the widget is told when the names change owner, and only then.
    static func widgetReloadOnAccountChange() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        func update(_ account: String?) {
            let done = DispatchSemaphore(value: 0)
            ShareSuggestions.update(SharedNames(account: account), root: root, deleteAll: { $0(nil) }, delete: { $1(nil) },
                                    accountChanged: { reloads += 1 }) { _ in done.signal() }
            precondition(done.wait(timeout: .now() + 5) == .success)
        }
        var reloads = 0
        update("me@example.com")
        precondition(reloads == 1, "Signing in reloads the widget")
        update("me@example.com")
        precondition(reloads == 1, "The same account leaves it alone")
        update(nil)
        precondition(reloads == 2, "Signing out reloads it")
    }

    /// An opted-in snapshot that does not cover the sender leaves the server's body alone.
    static func uncoveredBody() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let session: [String: Any] = ["account": "me@example.com", "epoch": "fixture", "revision": "", "activated": 0]
        let snapshot = try JSONSerialization.data(withJSONObject: [
            "account": "me@example.com", "opt_in": true, "peers": ["bob@example.com": []], "ledger": session])
        let content = UNMutableNotificationContent()
        content.body = "Plain message"
        content.userInfo = ["from": "alice@example.com/phone", "to": "me@example.com"]
        let service = NotificationService()
        service.loadNames = { SharedNames(account: "me@example.com") }
        service.readSnapshot = { snapshot }
        service.ledgerRoot = { root }
        var delivered = false
        service.didReceive(UNNotificationRequest(identifier: "uncovered", content: content, trigger: nil)) { result in
            precondition(result.body == "Plain message", "Got '\(result.body)'")
            delivered = true
        }
        precondition(delivered)
    }

    /// A push the server marks as unencrypted keeps its body without an archive fetch.
    static func serverPlaintext() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let session: [String: Any] = ["account": "me@example.com", "epoch": "fixture", "revision": "", "activated": 0]
        let snapshot = try JSONSerialization.data(withJSONObject: [
            "account": "me@example.com", "opt_in": true, "peers": ["alice@example.com": []], "ledger": session])
        let content = UNMutableNotificationContent()
        content.body = "Plain message"
        content.userInfo = ["from": "alice@example.com/phone", "to": "me@example.com", "encrypted": false]
        let service = NotificationService()
        service.loadNames = { SharedNames(account: "me@example.com") }
        service.readSnapshot = { snapshot }
        service.ledgerRoot = { root }
        var delivered = false
        service.didReceive(UNNotificationRequest(identifier: "server-plaintext", content: content, trigger: nil)) { result in
            precondition(result.body == "Plain message", "Got '\(result.body)'")
            delivered = true
        }
        precondition(delivered)
    }

    /// Intent: a push the extension skips records only its own decision in the diagnostic
    /// journal, never a trailing `noEngineResult`; an engine that ran without output still does.
    static func skipJournal() throws {
        let account = "me@example.com"
        let peer = "alice@example.com"
        let room = "team@muc.example.com"
        let names = SharedNames(contacts: [peer: "Alice"], rooms: [room: "Team"], account: account)
        var failures: [String] = []
        func run(_ name: String, expected: PreviewDecision, userInfo: [String: Any] = [:], allowed: Bool = true,
                 engine: Bool = false, setup: (URL, PreviewLedger) throws -> Data?) throws {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let journal = try NotificationDiagnostic(root: root)
            try journal.activate()
            let snapshot = try setup(root, PreviewLedger(root: root))
            let original = UNMutableNotificationContent()
            original.body = "[OpenPGP-encrypted message]"
            let push: [String: Any] = ["from": peer + "/phone", "to": account]
            original.userInfo = push.merging(userInfo) { $1 }
            if original.userInfo["encrypted"] as? Bool == false { original.body = "Are we still on for lunch?" }
            if userInfo["from"] is NSNull { original.userInfo["from"] = nil }
            let service = NotificationService()
            service.loadNames = { names }
            service.readSnapshot = { snapshot }
            service.ledgerRoot = { root }
            service.previewsAllowed = { $0(allowed) }
            var fetches = 0
            service.runPreview = { _, _, _, _, complete in
                fetches += 1
                complete(nil)
                return {}
            }
            var delivered: [UNNotificationContent] = []
            service.didReceive(UNNotificationRequest(identifier: name, content: original, trigger: nil)) { delivered.append($0) }
            let entries = try JSONDecoder().decode([NotificationDiagnostic.Entry].self, from: journal.export())
            // Widget publication decisions share the journal and the correlation; this scenario owns the preview decisions.
            let decisions = entries.map(\.decision.rawValue).filter { !$0.hasPrefix("widget") }
            print("\(name): \(decisions.joined(separator: ", "))")
            let fallback = NotificationPresentation.content(for: original, names: names, activity: PreviewWords.localized.activity)
            if decisions != [PreviewDecision.received.rawValue, expected.rawValue] { failures.append("\(name) recorded \(decisions)") }
            if Set(entries.map(\.correlation)).count != 1 { failures.append("\(name) split across processing runs") }
            if delivered.count != 1 || delivered.first?.body != fallback.body || delivered.first?.title != fallback.title {
                failures.append("\(name) delivered \(delivered.map { "\($0.title) / \($0.body)" })")
            }
            if fetches != (engine ? 1 : 0) { failures.append("\(name) ran the preview engine \(fetches) times") }
        }
        func snapshotData(_ session: PreviewLedger.Session?, account snapshotAccount: String = "me@example.com",
                      peers: [String] = ["alice@example.com"]) throws -> Data {
            var values: [String: Any] = ["account": snapshotAccount, "opt_in": true, "peers": Dictionary(uniqueKeysWithValues: peers.map { ($0, [String]()) })]
            if let session { values["ledger"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(session)) }
            return try JSONSerialization.data(withJSONObject: values)
        }
        func activated(_ ledger: PreviewLedger, now: Date = Date()) throws -> PreviewLedger.Session {
            try ledger.capability(account: account, purge: false, now: now.timeIntervalSince1970)!
        }
        try run("room", expected: .groupChat, userInfo: ["from": room + "/Alice"]) { _, ledger in try snapshotData(activated(ledger)) }
        try run("not encrypted", expected: .notEncrypted, userInfo: ["encrypted": false]) { _, ledger in try snapshotData(activated(ledger)) }
        try run("no sender", expected: .noSender, userInfo: ["from": NSNull()]) { _, ledger in try snapshotData(activated(ledger)) }
        try run("previews off", expected: .previewsOff) { _, _ in nil }
        try run("sender not covered", expected: .senderNotCovered) { _, ledger in try snapshotData(activated(ledger), peers: ["bob@example.com"]) }
        try run("snapshot for another account", expected: .snapshotChanged) { _, ledger in
            try snapshotData(activated(ledger), account: "other@example.com")
        }
        try run("no session", expected: .noSession) { _, _ in try snapshotData(nil) }
        try run("ledger unavailable", expected: .ledgerUnavailable) { root, ledger in
            let data = try snapshotData(activated(ledger))
            // A store that is no longer a database cannot be opened by the extension.
            try Data("not a database".utf8).write(to: root.appendingPathComponent("NotificationLedger.sqlite"))
            return data
        }
        try run("previews hidden", expected: .previewsHidden, allowed: false) { _, ledger in try snapshotData(activated(ledger)) }
        try run("capability changed", expected: .capabilityChanged) { _, ledger in
            let data = try snapshotData(activated(ledger))
            // The app refreshed the capability after writing this snapshot.
            _ = try activated(ledger)
            return data
        }
        try run("window unavailable", expected: .windowUnavailable) { _, ledger in
            // A capability activated after the device clock's current time has no archive window yet.
            try snapshotData(activated(ledger, now: Date().addingTimeInterval(3600)))
        }
        try run("engine without result", expected: .noEngineResult, engine: true) { _, ledger in try snapshotData(activated(ledger)) }
        for failure in failures { print(failure) }
        fflush(stdout)
        precondition(failures.isEmpty, "skip journal")
        print("skip journal passed")
    }

    static func fixtureImage() -> Data {
        // The mirror/image contracts use real project bytes, shared with the iOS fixture.
        let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        return try! Data(contentsOf: project.appendingPathComponent("assets/readme/fluux-logo.png"))
    }

    static func mirror() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let hash = String(repeating: "a", count: 40)
        let jid = "alice@example.com"
        var names = SharedNames(contacts: [jid: "Alice"], avatars: [jid: hash], account: "fixture@example.com")
        try NotificationMirror.writeNames(names, root: root)
        precondition(NotificationMirror.imageURL(for: jid, names: names, root: root) == nil)
        let payload = "{\"account\":\"fixture@example.com\",\"hash\":\"\(hash)\",\"data\":\"\(fixtureImage().base64EncodedString())\"}"
        let avatar = try JSONDecoder().decode(NotificationAvatar.self, from: Data(payload.utf8))
        try NotificationMirror.writeAvatar(avatar, root: root)
        let url = NotificationMirror.imageURL(for: jid, names: names, root: root)!
        let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        precondition(max(image.width, image.height) == 160)
        #if os(iOS)
        let protection = try FileManager.default.attributesOfItem(atPath: url.path)[.protectionKey] as? FileProtectionType
        precondition(protection == .completeUntilFirstUserAuthentication)
        #endif
        let intent = NotificationPresentation.intent(from: jid, body: "Fixture", names: names, root: root)!
        precondition(intent.sender?.image != nil)
        let saved = try Data(contentsOf: url)
        try Data("invalid image".utf8).write(to: url)
        precondition(NotificationPresentation.intent(from: jid, body: "Fixture", names: names, root: root)?.sender?.image == nil)
        try saved.write(to: url)
        let roomJid = "team@conference.example.com"
        names.rooms[roomJid] = "Team"
        names.avatars[roomJid] = hash
        let room = NotificationPresentation.intent(from: roomJid + "/Alice", body: "Fixture", names: names, root: root)!
        precondition(room.sender?.image == nil)
        #if os(iOS)
        precondition(room.image(forParameterNamed: \.speakableGroupName) != nil)
        #endif
        try NotificationMirror.writeNames(names, root: root)
        var launch = SharedNames(account: names.account)
        launch.preserveIfEmpty = true
        try NotificationMirror.writeNames(launch, root: root)
        precondition(SharedNames.load(root: root).contacts[jid] == "Alice")
        precondition(SharedNames.load(root: root).rooms[roomJid] == "Team")
        precondition(SharedNames.load(root: root).avatars == names.avatars)
        precondition(FileManager.default.fileExists(atPath: url.path))
        try NotificationMirror.writeNames(SharedNames(account: names.account), root: root)
        let empty = SharedNames.load(root: root)
        precondition(empty.contacts.isEmpty && empty.rooms.isEmpty && empty.avatars.isEmpty)
        precondition(!FileManager.default.fileExists(atPath: url.path))
        let staleWrite = try NotificationMirror.writeAvatar(avatar, root: root)
        precondition(!staleWrite)
        try NotificationMirror.writeNames(names, root: root)
        try NotificationMirror.writeAvatar(avatar, root: root)
        names.avatars.removeAll()
        try NotificationMirror.writeNames(names, root: root)
        precondition(!FileManager.default.fileExists(atPath: url.path))
        names.avatars[jid] = hash
        try NotificationMirror.writeNames(names, root: root)
        try NotificationMirror.writeAvatar(avatar, root: root)
        names.account = "other@example.com"
        try NotificationMirror.writeNames(names, root: root)
        precondition(!FileManager.default.fileExists(atPath: url.path))
        try NotificationMirror.writeAvatar(avatar, root: root)
        precondition(!FileManager.default.fileExists(atPath: url.path), "An old account must not repopulate the mirror")
        try NotificationMirror.writeNames(SharedNames(), root: root)
        precondition(SharedNames.load(root: root).avatars.isEmpty)
        let legacy = try JSONDecoder().decode(SharedNames.self, from: Data("{\"contacts\":{},\"rooms\":{}}".utf8))
        precondition(legacy.avatars.isEmpty)
        precondition(!NotificationMirror.validHash("../secret"))
        precondition(NotificationMirror.thumbnail(Data("invalid".utf8)) == nil)
        let many = Dictionary(uniqueKeysWithValues: (0...200).map {
            ("contact\($0)@example.com", String(format: "%040x", $0))
        })
        try NotificationMirror.writeNames(SharedNames(avatars: many, account: "bounds@example.com"), root: root)
        precondition(SharedNames.load(root: root).avatars.count == many.count)
        try NotificationMirror.writeNames(SharedNames(), root: root)
        precondition(!FileManager.default.fileExists(atPath: root.appendingPathComponent("Avatars").path))
    }

    static func conversations() {
        precondition(NotificationPresentation.conversation(of: ["__EXTRA__": ["navTarget": "Alice@Example.com"]]) == "alice@example.com")
        precondition(NotificationPresentation.conversation(of: ["from": "Alice@Example.com/phone"]) == "alice@example.com")
        precondition(NotificationPresentation.conversation(of: ["from": "team@conference.example.com/Bob"]) == "team@conference.example.com")
        for userInfo: [AnyHashable: Any] in [[:], ["from": "example.com"], ["from": ""], ["from": 42], ["to": "me@example.com"]] {
            precondition(NotificationPresentation.conversation(of: userInfo) == nil, "\(userInfo)")
        }
    }

    static func intents() {
        let names = SharedNames(contacts: ["alice@example.com": "Alice"], rooms: ["team@muc.example.com": "Team"], account: "me@example.com")
        let direct = NotificationPresentation.intent(from: "alice@example.com/phone", body: "Fixture", names: names)!
        precondition(direct.sender?.displayName == "Alice")
        precondition(direct.sender?.personHandle?.value == "alice@example.com")
        precondition(direct.sender?.image == nil)
        precondition(direct.speakableGroupName == nil)
        precondition(direct.recipients == nil && direct.donationMetadata == nil)
        precondition(ConversationDestination.decode(direct.conversationIdentifier) == ConversationDestination(account: "me@example.com", jid: "alice@example.com", type: "chat"))
        let room = NotificationPresentation.intent(from: "team@muc.example.com/Alice", body: "Fixture", names: names)!
        precondition(room.sender?.displayName == "Alice")
        precondition(room.sender?.personHandle?.value == "team@muc.example.com/Alice")
        precondition(room.speakableGroupName?.spokenPhrase == "Team")
        precondition(ConversationDestination.decode(room.conversationIdentifier) == ConversationDestination(account: "me@example.com", jid: "team@muc.example.com", type: "groupchat"))
        precondition(NotificationPresentation.intent(from: "unknown@example.com", body: "Fixture", names: names)?.conversationIdentifier == nil)
        precondition(NotificationPresentation.intent(from: "invalid", body: "Fixture", names: names) == nil)
    }

    /// Captain's report: tapping the Siri suggestion "Envoyer un message à Babette"
    /// opened the app on its current screen instead of Babette's conversation.
    static func suggestionLaunch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let names = SharedNames(contacts: ["babette@example.com": "Babette"], rooms: ["team@muc.example.com": "Team"], account: "me+work@example.com")
        for destination in [ConversationDestination(account: "me+work@example.com", jid: "babette@example.com", type: "chat"),
                            ConversationDestination(account: "me+work@example.com", jid: "team@muc.example.com", type: "groupchat")] {
            let donated = INInteraction(intent: ShareSuggestions.intent(for: destination, names: names, root: root)!, response: nil)
            // iOS keeps the donation archived and hands a decoded copy back with the tap.
            let archive = try NSKeyedArchiver.archivedData(withRootObject: donated, requiringSecureCoding: true)
            let tapped = try NSKeyedUnarchiver.unarchivedObject(ofClass: INInteraction.self, from: archive)!
            let opened = ShareSuggestions.destination(of: tapped.intent)
            precondition(opened == destination, "A tapped suggestion must name its own conversation")
            let link = URLComponents(url: ShortcutConversation(opened!).url(scheme: "net.processone.fluux")!, resolvingAgainstBaseURL: false)!
            precondition(link.scheme == "net.processone.fluux" && link.host == "shortcut")
            precondition(Set(link.queryItems!) == [URLQueryItem(name: "account", value: destination.account),
                                                   URLQueryItem(name: "kind", value: destination.type),
                                                   URLQueryItem(name: "id", value: destination.jid)])
        }
        precondition(ShareSuggestions.intent(for: ConversationDestination(account: "other@example.com", jid: "babette@example.com", type: "chat"), names: names, root: root) == nil,
                     "Only the signed-in account's conversations are suggested")
        let other = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText, content: nil, speakableGroupName: nil,
                                        conversationIdentifier: "babette@example.com", serviceName: nil, sender: nil, attachments: nil)
        precondition(ShareSuggestions.destination(of: other) == nil, "A conversation id Fluux did not donate opens nothing")
        precondition(ShareSuggestions.destination(of: INIntent()) == nil, "Only a message suggestion names a conversation")
        precondition(ShareSuggestions.destination(of: nil) == nil)
    }

    static func roomParticipants() throws {
        let json = #"{"account":"me@example.com","rooms":{"team@muc.example.com":"Team"},"roomParticipants":{"team@muc.example.com":{"ownNick":"Me","nicks":["Alice","Bob","Me"]}}}"#
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let jid = "team@muc.example.com"
        let from = jid + "/Alice"
        let hash = String(repeating: "c", count: 40)
        var input = try JSONDecoder().decode(SharedNames.self, from: Data(json.utf8))
        input.avatars[jid] = hash
        try NotificationMirror.writeNames(input, root: root)
        let names = SharedNames.load(root: root)
        precondition(NotificationPresentation.bareJid(from) == jid && names.rooms[jid] == "Team" && names.avatars[jid] == hash)
        let missing = NotificationPresentation.intent(from: from, body: "Fixture", names: names, root: root)!
        precondition(missing.sender?.image == nil && missing.speakableGroupName?.spokenPhrase == "Team")
        #if os(iOS)
        precondition(missing.image(forParameterNamed: \.speakableGroupName) == nil)
        #endif
        let payload = "{\"account\":\"me@example.com\",\"hash\":\"\(hash)\",\"data\":\"\(fixtureImage().base64EncodedString())\"}"
        let avatar = try JSONDecoder().decode(NotificationAvatar.self, from: Data(payload.utf8))
        let written = try NotificationMirror.writeAvatar(avatar, root: root)
        precondition(written)
        let url = NotificationMirror.imageURL(for: jid, names: names, root: root)!
        let saved = try Data(contentsOf: url)
        precondition(NotificationMirror.thumbnail(saved) != nil)
        let room = NotificationPresentation.intent(from: from, body: "Fixture", names: names, root: root)!
        precondition(room.recipients?.map { $0.personHandle!.value! } == ["team@muc.example.com/Bob"],
                     "A group intent must carry the other real recipients; sender and current user are implicit")
        precondition(room.recipients?.first?.displayName == "Bob")
        precondition(room.sender?.personHandle?.value == "team@muc.example.com/Alice")
        precondition(room.speakableGroupName?.spokenPhrase == "Team")
        precondition(room.sender?.image == nil)
        #if os(iOS)
        precondition(room.image(forParameterNamed: \.speakableGroupName) != nil)
        #endif
        try Data("corrupt".utf8).write(to: url)
        let corrupt = NotificationPresentation.intent(from: from, body: "Fixture", names: names, root: root)!
        precondition(corrupt.sender?.image == nil && corrupt.recipients?.count == 1)
        #if os(iOS)
        precondition(corrupt.image(forParameterNamed: \.speakableGroupName) == nil)
        #endif
        let unknown = NotificationPresentation.intent(from: "team@muc.example.com/Newcomer", body: "Fixture", names: names, root: root)!
        precondition(unknown.recipients == nil, "An unknown sender must not turn a partial snapshot into a full recipient list")
        let legacy = try JSONDecoder().decode(SharedNames.self, from: Data(#"{"rooms":{"team@muc.example.com":"Team"},"account":"me@example.com"}"#.utf8))
        precondition(legacy.roomParticipants.isEmpty)
        precondition(NotificationPresentation.intent(from: from, body: "Fixture", names: legacy, root: root)?.recipients == nil)
        try NotificationMirror.writeNames(legacy, root: root)
        precondition(SharedNames.load(root: root).roomParticipants[jid]?.nicks == ["Alice", "Bob", "Me"], "Suspension preserves last-known occupancy")
        var updated = input
        updated.roomParticipants[jid] = SharedRoomParticipants(ownNick: "Me", nicks: ["Alice", "Me"])
        try NotificationMirror.writeNames(updated, root: root)
        precondition(SharedNames.load(root: root).roomParticipants[jid]?.nicks == ["Alice", "Me"])
        precondition(NotificationPresentation.intent(from: from, body: "Fixture", names: SharedNames.load(root: root), root: root)?.recipients?.isEmpty == true,
                     "A two-person room must not invent an additional recipient")
        try NotificationMirror.writeNames(SharedNames(account: names.account), root: root)
        precondition(SharedNames.load(root: root).roomParticipants.isEmpty, "Removing a room removes its participants")
        try NotificationMirror.writeNames(input, root: root)
        var other = legacy
        other.account = "other@example.com"
        try NotificationMirror.writeNames(other, root: root)
        precondition(SharedNames.load(root: root).roomParticipants.isEmpty, "Account switches must not retain participants")
        try NotificationMirror.writeNames(input, root: root)
        try NotificationMirror.writeNames(SharedNames(), root: root)
        precondition(SharedNames.load(root: root).roomParticipants.isEmpty, "Logout wipes participants")
    }

    /// push_gate sends the room's bare address in `from` and the occupant's nick in `muc_nick`.
    static func mucNick() {
        let room = "team@muc.example.com"
        let json = #"{"account":"me@example.com","contacts":{"alice@example.com":"Alice"},"rooms":{"team@muc.example.com":"Team"},"roomParticipants":{"team@muc.example.com":{"ownNick":"Me","nicks":["Alice","Bob","Me"]}}}"#
        let names = try! JSONDecoder().decode(SharedNames.self, from: Data(json.utf8))
        func deliver(_ from: String, _ extra: [String: Any]) -> UNNotificationContent {
            let content = UNMutableNotificationContent()
            content.body = "Hello"
            content.userInfo = ["from": from, "to": "me@example.com"].merging(extra) { $1 }
            var output: UNNotificationContent?
            let service = NotificationService()
            service.loadNames = { names }
            service.readSnapshot = { nil }
            service.ledgerRoot = { nil }
            service.didReceive(UNNotificationRequest(identifier: "muc-nick", content: content, trigger: nil)) { output = $0 }
            return output!
        }
        let shown = deliver(room, ["muc_nick": "Alice"])
        precondition(shown.title == "Team" && shown.subtitle == "Alice" && shown.interruptionLevel != .passive)
        let legacy = deliver(room + "/Alice", [:])
        precondition(legacy.title == shown.title && legacy.subtitle == shown.subtitle)
        precondition(deliver(room + "/Alice", ["muc_nick": "Bob"]).subtitle == "Bob", "muc_nick wins over the from resource")
        precondition(deliver(room, ["muc_nick": "Me"]).interruptionLevel == .passive, "Own nick is delivered passively")
        for absent: [String: Any] in [[:], ["muc_nick": ""], ["muc_nick": 42]] {
            let result = deliver(room, absent)
            precondition(result.title == "Team" && result.subtitle.isEmpty, "\(absent)")
        }
        let direct = deliver("alice@example.com", ["muc_nick": "Mallory"])
        precondition(direct.title == "Alice" && direct.subtitle.isEmpty)
        let unknown = deliver("other@muc.example.com", ["muc_nick": "Mallory"])
        precondition(unknown.title == "other" && unknown.subtitle.isEmpty)
        let intent = NotificationPresentation.intent(from: NotificationPresentation.sender(of: ["from": room, "muc_nick": "Alice"], names: names)!, body: "Hello", names: names)!
        precondition(intent.sender?.displayName == "Alice" && intent.recipients?.map { $0.displayName } == ["Bob"])
        print("muc_nick passed")
    }

    /// Accepted room-attribution layout: room identity first, independent of occupancy.
    static func roomFirst() {
        let room = "xsf@muc.xmpp.org"
        for participants in [[:], [room: SharedRoomParticipants(ownNick: "Me", nicks: ["Seve", "Me"])]] {
            var names = SharedNames(contacts: ["seve@example.com": "Seve"], rooms: [room: "XSF"], account: "me@example.com")
            names.roomParticipants = participants
            for nick in ["Seve", ""] {
                let original = UNMutableNotificationContent()
                original.subtitle = "Stale server subtitle"
                original.body = "> finally, XSF funding!"
                original.threadIdentifier = "server-room-thread"
                original.sound = .default
                original.userInfo = ["from": room, "muc_nick": nick, "to": "me@example.com"]
                let from = NotificationPresentation.sender(of: original.userInfo, names: names)!
                let incoming = NotificationPresentation.incomingIntent(from: from, body: original.body, names: names)!
                precondition(incoming.sender?.personHandle?.value == room && incoming.sender?.displayName == names.rooms[room],
                             "The notification origin is the room, never an occupant")
                precondition(incoming.speakableGroupName == nil, "Do not restore an occupant-first group heading")
                let result = NotificationPresentation.content(for: original, names: names)
                precondition(result.title == names.rooms[room])
                #if os(iOS)
                precondition(result.subtitle.isEmpty && result.body == incoming.content)
                #else
                precondition(result.subtitle == nick && result.body == original.body)
                #endif
                precondition(result.threadIdentifier == original.threadIdentifier)
                precondition(result.sound != nil && result.userInfo["to"] as? String == "me@example.com")
                precondition(original.subtitle == "Stale server subtitle", "Do not mutate the request")
                print("Room alert: title=\(result.title), subtitle=\(result.subtitle), body=\(result.body)")
            }
            let direct = NotificationPresentation.incomingIntent(from: "seve@example.com", body: "Hello", names: names)
            precondition(direct?.sender?.displayName == "Seve" && direct?.content == "Hello")
        }
        print("room-first passed")
    }

    static func main() {
        switch CommandLine.arguments[1] {
        case "room-first":
            roomFirst()
        case "muc-nick":
            mucNick()
        case "room-participants":
            try! roomParticipants()
        case "account-guard":
            accountGuard()
        case "widget-reload":
            try! widgetReloadOnAccountChange()
        case "stalled-mirror-cleanup":
            try! stalledMirrorCleanup()
        case "signed-out":
            let content = UNMutableNotificationContent()
            content.title = "Private sender"
            content.subtitle = "Private room"
            content.body = "Private message"
            content.sound = .default
            content.badge = 9
            content.threadIdentifier = "private-thread"
            content.userInfo = ["from": "alice@example.com", "to": "signedout@example.com"]
            var delivered = false
            NotificationService().didReceive(UNNotificationRequest(identifier: "signed-out", content: content, trigger: nil)) { result in
                precondition(result.body != "Private message", "Signed-out push must not expose its body")
                precondition(result.title == "Fluux" && result.subtitle.isEmpty)
                precondition(result.sound == nil && result.badge == nil && result.threadIdentifier.isEmpty)
                precondition(result.userInfo.isEmpty && result.attachments.isEmpty)
                delivered = true
            }
            precondition(delivered)
        case "server-plaintext":
            try! serverPlaintext()
        case "uncovered-body":
            try! uncoveredBody()
        case "skip-journal":
            try! skipJournal()
        case "mirror":
            try! mirror()
        case "intents":
            intents()
        case "suggestion-launch":
            try! suggestionLaunch()
        case "conversations":
            conversations()
        case "direct":
            check(from: "alice@example.com/phone", expected: "alice@example.com")
            check(from: "alice@example.com", expected: "alice@example.com")
        case "room":
            check(from: "team@conference.example.com/alice", expected: "team@conference.example.com")
            check(from: "team@conference.example.com/bob", expected: "team@conference.example.com")
            check(from: "team@conference.example.com", expected: "team@conference.example.com")
        case "existing":
            check(from: "alice@example.com/phone", existing: "server-thread", expected: "server-thread")
            check(from: "team@conference.example.com/alice", existing: "room-thread", expected: "room-thread")
            check(existing: "server-thread", expected: "server-thread")
        case "missing":
            check(expected: "")
            for invalid: Any in [42, "", "example.com", "/alice@example.com", "@example.com", "alice@", " "] {
                check(from: invalid, expected: "")
            }
        default:
            preconditionFailure("Unknown fixture")
        }
        print("Notification grouping passed")
    }
}
