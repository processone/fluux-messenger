import Foundation

/// The account-owned unread membership shared by the app and notification extension.
/// `unread.count + events` is the app icon badge; the widget only lists counted conversations.
struct SharedBadge: Codable, Equatable {
    var unread: [String]
    var events: Int
    var notifyAllRooms: [String]
    // Legacy snapshots have no owner. They remain readable but cannot authorize widget pruning.
    var account: String? = nil
    var updated: Double? = nil

    static func load(root: URL? = NotificationMirror.root) -> SharedBadge? {
        guard let url = root?.appendingPathComponent("NotificationBadge.json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SharedBadge.self, from: data)
    }

    var count: Int { unread.count + events }

    // Same cross-process lock as UnreadList: badge changes cannot race its membership check/write.
    private static func locked<T>(root: URL, _ body: () throws -> T) throws -> T {
        let descriptor = open(root.appendingPathComponent("UnreadWidget.lock").path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        defer { flock(descriptor, LOCK_UN) }
        return try body()
    }

    private func writeUnlocked(root: URL) throws {
        try JSONEncoder().encode(self).write(to: root.appendingPathComponent("NotificationBadge.json"),
                                             options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    enum AppWrite: Equatable { case written, current, superseded }
    @discardableResult
    func writeIfChanged(root: URL, observed: (AppWrite) -> Void = { _ in }) throws -> Bool {
        let outcome: AppWrite = try Self.locked(root: root) {
            if let current = Self.load(root: root) {
                if current.account == account, current.unread == unread, current.events == events,
                   current.notifyAllRooms == notifyAllRooms { return .current }
                if let time = updated, let newer = current.updated, current.account == account,
                   newer > time, newer <= Date().timeIntervalSince1970 * 1000 { return .superseded }
            }
            try writeUnlocked(root: root)
            return .written
        }
        // Observation happens after releasing the shared writer lock, never inside the mutation.
        observed(outcome)
        return outcome == .written
    }

    /// Re-read under the lock, so overlapping extensions cannot discard another push's membership.
    /// Return the actual added decision rather than comparing with an earlier, possibly stale count.
    mutating func counting(adding from: String, rooms: [String: String], root: URL? = NotificationMirror.root) -> (count: Int, added: Bool) {
        let previous = self
        let update = { () -> (SharedBadge, Bool) in
            var current = Self.load(root: root) ?? previous
            guard current.account == previous.account else { return (previous, false) }
            let bare = from.split(separator: "/", maxSplits: 1).first.map(String.init) ?? from
            let isRoom = rooms[bare] != nil || current.notifyAllRooms.contains(bare)
            guard !current.unread.contains(bare), !isRoom || current.notifyAllRooms.contains(bare) else { return (current, false) }
            current.unread.append(bare)
            current.updated = floor(Date().timeIntervalSince1970 * 1000)
            if let root { try? current.writeUnlocked(root: root) }
            return (current, true)
        }
        let result: (SharedBadge, Bool)
        if let root {
            do { result = try Self.locked(root: root, update) }
            catch { return (count, false) }
        } else { result = update() }
        self = result.0
        return (count, result.1)
    }

    mutating func count(adding from: String, rooms: [String: String], root: URL? = NotificationMirror.root) -> Int {
        counting(adding: from, rooms: rooms, root: root).count
    }
}
