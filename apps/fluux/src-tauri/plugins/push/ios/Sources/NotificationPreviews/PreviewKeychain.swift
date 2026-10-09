import Foundation
import Security

/// A single item publishes credentials, subkeys and public trust as one generation.
enum PreviewKeychain {
    static let service = "net.processone.fluux.notification-preview"
    static let account = "active"
    static let maxBytes = 512 * 1024
    static var group: String? { Bundle.main.object(forInfoDictionaryKey: "FluuxPreviewKeychainGroup") as? String }

    static func query(group: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrAccessGroup as String: group,
         kSecAttrSynchronizable as String: false]
    }
    static func read(group: String? = group) -> Data? {
        guard let group = group else { return nil }
        var query = query(group: group)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, data.count <= maxBytes else { return nil }
        return data
    }
    static func write(_ data: Data?, group: String? = group) throws {
        guard let group = group else { throw failure(errSecMissingEntitlement) }
        let query = query(group: group)
        guard let data = data else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
            return
        }
        guard data.count <= maxBytes,
              let snapshot = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              snapshot["opt_in"] as? Bool == true,
              let owner = snapshot["account"] as? String, NotificationPresentation.bareJid(owner) == owner,
              snapshot["password"] is String, snapshot["secret_b64"] is String else { throw failure(errSecParam) }
        let values: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            values.forEach { item[$0.key] = $0.value }
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw failure(added) }
        } else if status != errSecSuccess { throw failure(status) }
        guard read(group: group) == data else { throw failure(errSecNotAvailable) }
    }
    private static func failure(_ status: OSStatus) -> NSError {
        NSError(domain: "FluuxNotificationPreviewKeychain", code: Int(status), userInfo: nil)
    }
}
