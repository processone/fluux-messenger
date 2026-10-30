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
    /// The account the published capability belongs to, or nil when none is published.
    static func publishedAccount(group: String? = group) -> String? {
        read(group: group).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["account"] as? String
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

    enum Change: Equatable {
        /// The server issued a successor to the token that was used.
        case rotate(token: String, expiry: String)
        /// The server refused the token that was used.
        case clear
    }

    /// The record to store after an extension run that used `used`, or nil to leave the keychain
    /// as it is. A run only changes the token it started from: a newer token, or a deletion by a
    /// sign-out or an account change, wins. A run that started without a token may create the
    /// first one only while the capability it ran under is still published. Revocation
    /// rejects every late write, including when the old credential is still stored.
    static func resolve(used: PreviewToken, stored: PreviewToken?, snapshotCurrent: Bool, change: Change) -> PreviewToken? {
        guard snapshotCurrent else { return nil }
        if let stored = stored {
            guard stored == used else { return nil }
        } else {
            guard used.token.isEmpty else { return nil }
        }
        var next = used
        switch change {
        case let .rotate(token, expiry):
            next.token = token
            next.expiry = expiry
        case .clear:
            guard !used.token.isEmpty else { return nil }
            next.token = ""
            next.expiry = ""
        }
        return next
    }

    enum LockFailure: Error { case unavailable }

    /// Short state transactions serialize capability publication/revocation with credential
    /// reads/writes, never network work. The app must not wait on the sign-in lock to revoke.
    static func withStateLock<T>(root: URL, onUnavailable: () throws -> Void = {}, _ body: () throws -> T) throws -> T {
        guard let descriptor = lock(root: root, name: "preview-state.lock") else {
            // Revocation may still delete the published capability, but publication and
            // the rest of the state transaction must never proceed without the lock.
            try onUnavailable()
            throw LockFailure.unavailable
        }
        defer { flock(descriptor, LOCK_UN); close(descriptor) }
        return try body()
    }

    private static func lock(root: URL, name: String) -> Int32? {
        let descriptor = open(root.appendingPathComponent(name).path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { return nil }
        guard flock(descriptor, LOCK_EX) == 0 else { close(descriptor); return nil }
        return descriptor
    }

    /// Sign-ins must not proceed without the shared lock. Unlike best-effort cleanup,
    /// an unlocked network request can rotate the server token behind another lookup.
    static func withSignInLock<T>(root: URL, _ body: () -> T) -> T? {
        guard let descriptor = lock(root: root, name: "fast-token.lock") else { return nil }
        defer { flock(descriptor, LOCK_UN); close(descriptor) }
        return body()
    }

    /// Caller holds preview-state.lock for this write and its capability check.
    /// The worker separately holds fast-token.lock across the whole sign-in.
    @discardableResult
    static func recordLocked(_ change: Change, after used: PreviewToken, snapshotCurrent: () -> Bool,
                             group: String? = PreviewKeychain.group) -> Bool {
        guard let next = resolve(used: used, stored: stored(group: group), snapshotCurrent: snapshotCurrent(), change: change) else { return false }
        return (try? next.save(group: group)) != nil
    }
}
