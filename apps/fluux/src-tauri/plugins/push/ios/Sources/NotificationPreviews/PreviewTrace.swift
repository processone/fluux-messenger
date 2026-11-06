import Foundation
import os
import SQLite3

/// A closed vocabulary prevents payloads, identities and engine errors entering the export.
enum PreviewDecision: String, Codable {
    case received, wrongAccount, ownRoomMessage, notEncrypted, noSender, groupChat
    case previewsOff, senderNotCovered, snapshotChanged, noSession, ledgerUnavailable
    case previewsHidden, capabilityChanged, windowUnavailable, archiveUnavailable
    case deadline, systemExpiry, preview, noEngineResult, nothingNew, appShown, appDuplicate
    case widgetNotCounted, widgetBadgeUnavailable, widgetListUnavailable, widgetAccountMismatch, widgetAlreadyListed
    case widgetRowSelected, widgetWriteSucceeded, widgetWriteFailed, widgetReloadRequested, widgetReloadUnavailable
    case widgetCountMismatch, widgetAppReadObserved, widgetAppReadStillListed, widgetAppReadNotListed, widgetAppReadStateUnavailable
    case widgetAppListWritten, widgetAppListCleared, widgetAppWriteFailed, widgetAppReloadRequested
}

/// Cross-process, bounded diagnostic storage. Session markers contain no account identifier.
final class NotificationDiagnostic {
    static let limit = 200
    static let lifetime: TimeInterval = 48 * 3600
    struct Entry: Codable {
        let version: String
        let time: TimeInterval
        let correlation: UUID
        let decision: PreviewDecision
        let durationMs: Int?
    }
    private var db: OpaquePointer?
    enum Failure: Error { case unavailable }
    init(root: URL) throws {
        let url = root.appendingPathComponent("NotificationDiagnostic.sqlite")
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw Failure.unavailable }
        // App/extension bursts can hold the writer longer than 150 ms on slower storage.
        // Keep contention recoverable without waiting indefinitely or changing journal retention.
        sqlite3_busy_timeout(db, 2_000)
        try sql("PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA max_page_count=128")
        try sql("CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK(id=1), marker TEXT NOT NULL)")
        try sql("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, time REAL NOT NULL, data BLOB NOT NULL)")
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
        var excluded = url
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
    }
    deinit { sqlite3_close(db) }
    private func sql(_ text: String) throws {
        guard sqlite3_exec(db, text, nil, nil, nil) == SQLITE_OK else { throw Failure.unavailable }
    }
    private func transaction<T>(_ work: () throws -> T) throws -> T {
        try sql("BEGIN IMMEDIATE")
        do { let result = try work(); try sql("COMMIT"); return result }
        catch { try? sql("ROLLBACK"); throw error }
    }
    func session() throws -> UUID? {
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(db, "SELECT marker FROM session WHERE id=1", -1, &statement, nil) == SQLITE_OK else { throw Failure.unavailable }
        guard sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { return nil }
        return UUID(uuidString: String(cString: text))
    }
    /// Rotate before logout/account changes so in-flight extension work cannot restore old entries.
    func reset(active: Bool) throws {
        try transaction {
            try sql("DELETE FROM entries; DELETE FROM session")
            if active { try sql("INSERT INTO session VALUES(1, '\(UUID().uuidString)')") }
        }
    }
    func activate() throws {
        try transaction {
            if try session() == nil { try sql("INSERT INTO session VALUES(1, '\(UUID().uuidString)')") }
        }
    }
    private func prune(now: TimeInterval) throws {
        guard now.isFinite else { throw Failure.unavailable }
        try sql("DELETE FROM entries WHERE time <= \(now - Self.lifetime) OR time > \(now)")
        try sql("DELETE FROM entries WHERE id NOT IN (SELECT id FROM entries ORDER BY id DESC LIMIT \(Self.limit))")
    }
    func append(_ entry: Entry, session marker: UUID, now: TimeInterval? = nil) throws {
        try append([entry], session: marker, now: now)
    }
    /// A widget decision/write/reload sequence spends one bounded lock wait, not one per event.
    func append(_ entries: [Entry], session marker: UUID, now: TimeInterval? = nil) throws {
        guard !entries.isEmpty else { return }
        try transaction {
            // A queued writer must not mistake newer committed entries for a clock rollback.
            let now = now ?? Date().timeIntervalSince1970
            try prune(now: now)
            guard try session() == marker else { return }
            for entry in entries where entry.time > now - Self.lifetime && entry.time <= now {
                let data = try JSONEncoder().encode(entry)
                var statement: OpaquePointer?
                defer { sqlite3_finalize(statement) }
                guard sqlite3_prepare_v2(db, "INSERT INTO entries(time,data) VALUES(?,?)", -1, &statement, nil) == SQLITE_OK else { throw Failure.unavailable }
                sqlite3_bind_double(statement, 1, entry.time)
                let status = data.withUnsafeBytes { bytes -> Int32 in
                    sqlite3_bind_blob(statement, 2, bytes.baseAddress, Int32(bytes.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                }
                guard status == SQLITE_OK, sqlite3_step(statement) == SQLITE_DONE else { throw Failure.unavailable }
            }
            try prune(now: now)
        }
    }
    func export(now: TimeInterval? = nil) throws -> Data {
        try transaction {
            let now = now ?? Date().timeIntervalSince1970
            try prune(now: now)
            var statement: OpaquePointer?
            defer { sqlite3_finalize(statement) }
            guard sqlite3_prepare_v2(db, "SELECT data FROM entries ORDER BY id", -1, &statement, nil) == SQLITE_OK else { throw Failure.unavailable }
            var entries: [Entry] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                guard let bytes = sqlite3_column_blob(statement, 0) else { throw Failure.unavailable }
                entries.append(try JSONDecoder().decode(Entry.self, from: Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0)))))
            }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            return try encoder.encode(entries)
        }
    }
}

/// Existing system trace remains separate from the allowlisted local diagnostic.
enum PreviewTrace {
    private static let log = Logger(subsystem: "net.processone.fluux", category: "notification")
    static func note(_ message: String) { log.notice("\(message, privacy: .public)") }
    struct Event {
        let decision: PreviewDecision
        let time: TimeInterval
        var durationMs: Int? = nil
    }
    /// Owned by the app's mirror queue. Targets are bounded in memory and checked within the journal's time window.
    /// Observe the read now, but inspect its effect after publication, not during the 500 ms debounce.
    final class AppReads {
        private var owner: String?
        private var targets: [String: TimeInterval] = [:]

        var hasPending: Bool { !targets.isEmpty }
        func clear() { owner = nil; targets.removeAll() }

        func observed(account: String, target: String, time: TimeInterval) -> [Event] {
            if owner != account { clear(); owner = account }
            targets[target.lowercased()] = time
            if targets.count > NotificationDiagnostic.limit, let oldest = targets.min(by: { $0.value < $1.value })?.key {
                targets.removeValue(forKey: oldest)
            }
            return [.init(decision: .widgetAppReadObserved, time: time)]
        }

        func published(root: URL, account: String, snapshotAt: TimeInterval? = nil,
                       time: TimeInterval = Date().timeIntervalSince1970) -> [Event] {
            guard owner == account else { return [] }
            targets = targets.filter { $0.value <= time && time - $0.value < NotificationDiagnostic.lifetime }
            let eligible = targets.filter { target in snapshotAt.map { target.value <= $0 } ?? true }
            guard !eligible.isEmpty else { return [] }
            guard let data = try? Data(contentsOf: root.appendingPathComponent("UnreadWidget.json")),
                  let list = try? JSONDecoder().decode(WidgetReadSnapshot.self, from: data), list.account == account else {
                return [.init(decision: .widgetAppReadStateUnavailable, time: time)]
            }
            let listed = Set(list.rows.map { $0.id.lowercased() })
            var events: [Event] = []
            if eligible.keys.contains(where: { !listed.contains($0) }) {
                events.append(.init(decision: .widgetAppReadNotListed, time: time))
            }
            for target in eligible.keys where !listed.contains(target) { targets.removeValue(forKey: target) }
            if eligible.keys.contains(where: { listed.contains($0) }) { events.append(.init(decision: .widgetAppReadStillListed, time: time)) }
            return events
        }
    }
    private struct WidgetReadSnapshot: Decodable {
        struct Row: Decodable { let id: String }
        let account: String
        let total: Int
        let rows: [Row]
    }

    /// Widgets and push are separate Swift packages. Fixed in-process events share the existing
    /// journal without a second persistent log or a new public command.
    static func observeWidgetPublications(root: @escaping () -> URL?, account: @escaping () -> String?, queue: DispatchQueue,
                                          needsReadCheck: @escaping () -> Bool = { true },
                                          afterPublication: @escaping (URL, String, TimeInterval?) -> [Event] = { _, _, _ in [] },
                                          center: NotificationCenter = .default) -> NSObjectProtocol {
        center.addObserver(forName: Notification.Name("net.processone.fluux.widget-publication"), object: nil, queue: nil) { note in
            guard let owner = note.userInfo?["account"] as? String,
                  let values = note.userInfo?["events"] as? [[String: Any]] else { return }
            let snapshotAt = (note.userInfo?["snapshotAt"] as? TimeInterval).flatMap { $0.isFinite ? $0 : nil }
            // Posting must not wait for SQLite or a read-state inspection to finish.
            queue.async {
                // A native no-op with no pending reads needs neither account-file I/O nor SQLite.
                if values.isEmpty && (snapshotAt == nil || !needsReadCheck()) { return }
                guard owner == account(), let root = root() else { return }
                let allowed: [PreviewDecision] = [.widgetAppListWritten, .widgetAppListCleared, .widgetAppWriteFailed, .widgetAppReloadRequested]
                var events = values.compactMap { value -> Event? in
                    guard let raw = value["decision"] as? String, let decision = PreviewDecision(rawValue: raw), allowed.contains(decision),
                          let time = value["time"] as? TimeInterval, time.isFinite else { return nil }
                    return .init(decision: decision, time: time)
                }
                guard events.count == values.count else { return }
                if snapshotAt != nil || events.contains(where: { $0.decision == .widgetAppListWritten || $0.decision == .widgetAppListCleared }) {
                    events += afterPublication(root, owner, snapshotAt)
                }
                guard !events.isEmpty else { return }
                batchRecorder(root: root, correlation: UUID())(events)
            }
        }
    }
    static func recorder(root: URL?) -> (PreviewDecision, Int?) -> Void {
        let record = batchRecorder(root: root, correlation: UUID())
        return { decision, duration in
            record([Event(decision: decision, time: Date().timeIntervalSince1970, durationMs: duration)])
        }
    }
    static func batchRecorder(root: URL?, correlation: UUID) -> ([Event]) -> Void {
        guard let root, let store = try? NotificationDiagnostic(root: root), let session = try? store.session() else { return { _ in } }
        let version = "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"))"
        return { events in
            // Diagnostic I/O is best effort and never changes notification presentation.
            guard let store = try? NotificationDiagnostic(root: root) else { return }
            let entries = events.map {
                NotificationDiagnostic.Entry(version: version, time: $0.time, correlation: correlation,
                                             decision: $0.decision, durationMs: $0.durationMs)
            }
            try? store.append(entries, session: session)
        }
    }
}

#if os(iOS)
import UIKit

/// Owns only the diagnostic share copy; never uploads or opens a destination itself.
enum NotificationDiagnosticShare {
    static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("notification-diagnostic", isDirectory: true)
    }
    static func clear() { try? FileManager.default.removeItem(at: directory) }
    static func present(data: Data, from presenter: UIViewController, completion: @escaping () -> Void) throws {
        guard presenter.presentedViewController == nil else { throw NotificationDiagnostic.Failure.unavailable }
        clear()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("fluux-notification-diagnostic.json")
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in clear(); completion() }
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        presenter.present(sheet, animated: true)
    }
}
#endif
