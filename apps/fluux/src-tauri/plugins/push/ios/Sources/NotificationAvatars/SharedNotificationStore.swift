import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Metadata only; an entry carries its owner across saved shortcuts and account switches.
struct ShortcutConversation: Codable, Equatable {
    let id: String
    let name: String
    let kind: String
    let account: String

    var destination: ConversationDestination {
        ConversationDestination(account: account, jid: id, type: kind)
    }

    static func available(in names: SharedNames) -> [Self] {
        names.conversations.filter { $0.account == names.account && $0.destination.isValid }
    }

    static func resolve(identifiers: [String], in names: SharedNames) -> [Self] {
        let current = available(in: names)
        return identifiers.compactMap { identifier in
            if let entry = current.first(where: { $0.destination.identifier == identifier }) { return entry }
            // A saved shortcut must still open the app after logout or removal.
            // Only the live WebView session can authorize navigation to its target.
            guard let destination = ConversationDestination.decode(identifier) else { return nil }
            return Self(id: destination.jid, name: destination.jid, kind: destination.type, account: destination.account)
        }
    }

    func url(scheme: String) -> URL? {
        guard destination.isValid else { return nil }
        var url = URLComponents()
        url.scheme = scheme
        url.host = "shortcut"
        url.queryItems = [URLQueryItem(name: "account", value: account),
                          URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "id", value: id)]
        // URLSearchParams in the WebView treats a raw plus as a form-encoded space.
        url.percentEncodedQuery = url.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return url.url
    }
}

/// Last known room occupancy, using room-scoped handles rather than exposing members' real JIDs.
struct SharedRoomParticipants: Codable {
    let ownNick: String
    let nicks: [String]
}

/// App Group schema shared by the push plugin, notification extension and App Intents.
struct SharedNames: Codable {
    var contacts: [String: String] = [:]
    var rooms: [String: String] = [:]
    var avatars: [String: String] = [:]
    var roomParticipants: [String: SharedRoomParticipants] = [:]
    var conversations: [ShortcutConversation] = []
    var account: String?
    var preserveIfEmpty = false

    init(contacts: [String: String] = [:], rooms: [String: String] = [:],
         avatars: [String: String] = [:], account: String? = nil) {
        self.contacts = contacts
        self.rooms = rooms
        self.avatars = avatars
        self.account = account
    }

    enum CodingKeys: String, CodingKey { case contacts, rooms, avatars, roomParticipants, conversations, account, preserveIfEmpty }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        conversations = try values.decodeIfPresent([ShortcutConversation].self, forKey: .conversations) ?? []
        contacts = try values.decodeIfPresent([String: String].self, forKey: .contacts) ?? [:]
        rooms = try values.decodeIfPresent([String: String].self, forKey: .rooms) ?? [:]
        avatars = try values.decodeIfPresent([String: String].self, forKey: .avatars) ?? [:]
        roomParticipants = try values.decodeIfPresent([String: SharedRoomParticipants].self, forKey: .roomParticipants) ?? [:]
        account = try values.decodeIfPresent(String.self, forKey: .account)
        preserveIfEmpty = try values.decodeIfPresent(Bool.self, forKey: .preserveIfEmpty) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(conversations, forKey: .conversations)
        try values.encode(contacts, forKey: .contacts)
        try values.encode(rooms, forKey: .rooms)
        try values.encode(avatars, forKey: .avatars)
        try values.encode(roomParticipants, forKey: .roomParticipants)
        try values.encodeIfPresent(account, forKey: .account)
    }

    static func load(root: URL? = NotificationMirror.root) -> SharedNames {
        guard let root = root,
              let data = try? Data(contentsOf: root.appendingPathComponent("NotificationNames.json")),
              let names = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return names
    }
}

struct NotificationAvatar: Decodable {
    let account: String
    let hash: String
    let data: String
}

/// A disposable mirror: the WebView's avatar cache owns the source images.
enum NotificationMirror {
    static let maxImageBytes = 64 * 1024
    static let maxSourceBytes = 2 * 1024 * 1024

    static var root: URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    }

    static func validHash(_ hash: String) -> Bool {
        hash.count == 40 && hash.unicodeScalars.allSatisfy { (48...57).contains($0.value) || (97...102).contains($0.value) }
    }

    static func imageURL(for jid: String, names: SharedNames, root: URL? = root) -> URL? {
        guard let root = root, let hash = names.avatars[jid], validHash(hash) else { return nil }
        let url = root.appendingPathComponent("Avatars", isDirectory: true).appendingPathComponent(hash + ".jpg")
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= maxImageBytes else { return nil }
        return url
    }

    static func writeNames(_ input: SharedNames, root: URL) throws {
        let files = FileManager.default
        let directory = root.appendingPathComponent("Avatars", isDirectory: true)
        let old = SharedNames.load(root: root)
        if input.preserveIfEmpty, input.account != nil, old.account == input.account,
           input.contacts.isEmpty, input.rooms.isEmpty, input.avatars.isEmpty { return }
        var names = input
        names.preserveIfEmpty = false
        if names.account == nil {
            names = SharedNames()
        } else {
            names.conversations = input.conversations.filter {
                $0.account == input.account && $0.destination.isValid
            }
            names.avatars = input.avatars.filter { validHash($0.value) }
            // A suspended connection has no live occupancy; retain the last snapshot for retained rooms.
            let previous = old.account == input.account ? old.roomParticipants : [:]
            names.roomParticipants = previous.merging(input.roomParticipants) { _, current in current }
                .filter { input.rooms[$0.key] != nil }
        }
        if old.account != names.account || names.account == nil {
            try JSONEncoder().encode(SharedNames()).write(to: root.appendingPathComponent("NotificationNames.json"),
                                                        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            if files.fileExists(atPath: directory.path) { try files.removeItem(at: directory) }
        }
        try JSONEncoder().encode(names).write(to: root.appendingPathComponent("NotificationNames.json"),
                                             options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        let retained = Set(names.avatars.values.map { $0 + ".jpg" })
        for url in (try? files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
            if !retained.contains(url.lastPathComponent) { try files.removeItem(at: url) }
        }
    }

    @discardableResult
    static func writeAvatar(_ avatar: NotificationAvatar, root: URL) throws -> Bool {
        let names = SharedNames.load(root: root)
        guard names.account == avatar.account, validHash(avatar.hash), names.avatars.values.contains(avatar.hash),
              avatar.data.utf8.count <= (maxSourceBytes * 4 / 3 + 4),
              let data = Data(base64Encoded: avatar.data), data.count <= maxSourceBytes,
              let reduced = thumbnail(data) else { return false }
        let files = FileManager.default
        let directory = root.appendingPathComponent("Avatars", isDirectory: true)
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        try files.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
        try reduced.write(to: directory.appendingPathComponent(avatar.hash + ".jpg"),
                          options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return true
    }

    static func thumbnail(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 160,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length <= maxImageBytes else { return nil }
        return output as Data
    }
}
