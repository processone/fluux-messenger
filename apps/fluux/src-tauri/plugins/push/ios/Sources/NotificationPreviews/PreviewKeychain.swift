import Foundation
import Security

/// A single item publishes credentials, subkeys and public trust as one generation.
enum PreviewKeychain {
    static let service = "net.processone.fluux.notification-preview"
    static let account = "active"
    static let maxBytes = 512 * 1024
    static var group: String? { Bundle.main.object(forInfoDictionaryKey: "FluuxPreviewKeychainGroup") as? String }

    static func query(group: String, item: String = account) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: item, kSecAttrAccessGroup as String: group,
         kSecAttrSynchronizable as String: false]
    }
    static func read(group: String? = group, item: String = account) -> Data? {
        guard let group = group else { return nil }
        var query = query(group: group, item: item)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, data.count <= maxBytes else { return nil }
        return data
    }
    static func write(_ data: Data?, group: String? = group) throws {
        if let data = data {
            guard data.count <= maxBytes,
                  let snapshot = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  snapshot["opt_in"] as? Bool == true,
                  let owner = snapshot["account"] as? String, NotificationPresentation.bareJid(owner) == owner,
                  snapshot["password"] is String, snapshot["secret_b64"] is String else { throw failure(errSecParam) }
        }
        try store(data, group: group, item: account)
    }
    static func store(_ data: Data?, group: String?, item: String) throws {
        guard let group = group else { throw failure(errSecMissingEntitlement) }
        let query = query(group: group, item: item)
        guard let data = data else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
            return
        }
        guard data.count <= maxBytes else { throw failure(errSecParam) }
        let values: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var entry = query
            values.forEach { entry[$0.key] = $0.value }
            let added = SecItemAdd(entry as CFDictionary, nil)
            guard added == errSecSuccess else { throw failure(added) }
        } else if status != errSecSuccess { throw failure(status) }
        guard read(group: group, item: item) == data else { throw failure(errSecNotAvailable) }
    }
    static func failure(_ status: OSStatus) -> NSError {
        NSError(domain: "FluuxNotificationPreviewKeychain", code: Int(status), userInfo: nil)
    }
}

/// The extension's own XEP-0484 FAST token, in its own item so the extension can store a
/// rotated token without touching the snapshot the app publishes.
struct PreviewToken: Codable, Equatable {
    static let item = "fast-token"
    let account: String
    /// XEP-0388 user agent the token is bound to, distinct from the app's.
    let userAgentId: String
    var token: String
    var expiry: String

    /// The stored token for `account`, or a new user agent without a token yet.
    static func load(for account: String, group: String? = PreviewKeychain.group) -> PreviewToken {
        if let data = PreviewKeychain.read(group: group, item: item),
           let stored = try? JSONDecoder().decode(PreviewToken.self, from: data), stored.account == account {
            return stored
        }
        return PreviewToken(account: account, userAgentId: UUID().uuidString.lowercased(), token: "", expiry: "")
    }
    static func stored(group: String? = PreviewKeychain.group) -> PreviewToken? {
        PreviewKeychain.read(group: group, item: item).flatMap { try? JSONDecoder().decode(PreviewToken.self, from: $0) }
    }
    func save(group: String? = PreviewKeychain.group) throws {
        try PreviewKeychain.store(JSONEncoder().encode(self), group: group, item: Self.item)
    }
    static func delete(group: String? = PreviewKeychain.group) throws {
        try PreviewKeychain.store(nil, group: group, item: item)
    }
}
