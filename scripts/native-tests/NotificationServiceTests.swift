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

    static func fixtureImage() -> Data {
        let context = CGContext(data: nil, width: 640, height: 480, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(red: 0.3, green: 0.5, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 640, height: 480))
        let output = NSMutableData()
        let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        precondition(CGImageDestinationFinalize(destination))
        return output as Data
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

    static func intents() {
        let names = SharedNames(contacts: ["alice@example.com": "Alice"], rooms: ["team@muc.example.com": "Team"], account: "me@example.com")
        let direct = NotificationPresentation.intent(from: "alice@example.com/phone", body: "Fixture", names: names)!
        precondition(direct.sender?.displayName == "Alice")
        precondition(direct.sender?.personHandle?.value == "alice@example.com")
        precondition(direct.sender?.image == nil)
        precondition(direct.speakableGroupName == nil)
        precondition(ConversationDestination.decode(direct.conversationIdentifier) == ConversationDestination(account: "me@example.com", jid: "alice@example.com", type: "chat"))
        let room = NotificationPresentation.intent(from: "team@muc.example.com/Alice", body: "Fixture", names: names)!
        precondition(room.sender?.displayName == "Alice")
        precondition(room.sender?.personHandle?.value == "team@muc.example.com/Alice")
        precondition(room.speakableGroupName?.spokenPhrase == "Team")
        precondition(ConversationDestination.decode(room.conversationIdentifier) == ConversationDestination(account: "me@example.com", jid: "team@muc.example.com", type: "groupchat"))
        precondition(NotificationPresentation.intent(from: "unknown@example.com", body: "Fixture", names: names)?.conversationIdentifier == nil)
        precondition(NotificationPresentation.intent(from: "invalid", body: "Fixture", names: names) == nil)
    }

    static func main() {
        switch CommandLine.arguments[1] {
        case "account-guard":
            accountGuard()
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
        case "uncovered-body":
            try! uncoveredBody()
        case "mirror":
            try! mirror()
        case "intents":
            intents()
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
