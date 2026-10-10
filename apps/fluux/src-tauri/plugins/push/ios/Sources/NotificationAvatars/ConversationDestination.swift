import Foundation

/// An opaque system suggestion identifies both its account and conversation.
struct ConversationDestination: Codable, Equatable {
    let account: String
    let jid: String
    let type: String

    var isValid: Bool {
        [account, jid].allSatisfy { value in
            let parts = value.split(separator: "@", omittingEmptySubsequences: false)
            return value.utf8.count <= 3071 && parts.count == 2 && parts.allSatisfy { !$0.isEmpty } &&
                !value.contains("/") && value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
        } && (type == "chat" || type == "groupchat")
    }

    var identifier: String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        guard isValid, let data = try? encoder.encode(self) else { return nil }
        return "fluux:" + data.base64EncodedString()
    }

    static func decode(_ identifier: String?) -> Self? {
        guard let identifier, identifier.hasPrefix("fluux:"), identifier.utf8.count <= 16384,
              let data = Data(base64Encoded: String(identifier.dropFirst(6))),
              let value = try? JSONDecoder().decode(Self.self, from: data), value.isValid else { return nil }
        return value
    }

    static func obsoleteIdentifiers(in old: SharedNames, keeping next: SharedNames) -> [String] {
        guard let account = old.account else { return [] }
        let previous = old.contacts.keys.map { Self(account: account, jid: $0, type: "chat") } +
            old.rooms.keys.map { Self(account: account, jid: $0, type: "groupchat") }
        return previous.filter { !$0.belongs(to: next) }.compactMap { $0.identifier }
    }

    func belongs(to names: SharedNames) -> Bool {
        isValid && names.account == account && (type == "chat" ? names.contacts[jid] != nil : names.rooms[jid] != nil)
    }
}
