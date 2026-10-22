import Foundation
import os
import SQLite3

/// A closed vocabulary prevents payloads, identities and engine errors entering the export.
enum PreviewDecision: String, Codable {
    case received, wrongAccount, ownRoomMessage, notEncrypted, noSender, groupChat
    case previewsOff, senderNotCovered, snapshotChanged, noSession, ledgerUnavailable
    case previewsHidden, capabilityChanged, windowUnavailable, archiveUnavailable
    case deadline, systemExpiry, preview, noEngineResult, nothingNew, appShown, appDuplicate
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
        try transaction {
            // A queued writer must not mistake newer committed entries for a clock rollback.
            let now = now ?? Date().timeIntervalSince1970
            try prune(now: now)
            guard try session() == marker, entry.time > now - Self.lifetime, entry.time <= now else { return }
            let data = try JSONEncoder().encode(entry)
            var statement: OpaquePointer?
            defer { sqlite3_finalize(statement) }
            guard sqlite3_prepare_v2(db, "INSERT INTO entries(time,data) VALUES(?,?)", -1, &statement, nil) == SQLITE_OK else { throw Failure.unavailable }
            sqlite3_bind_double(statement, 1, entry.time)
            let status = data.withUnsafeBytes { bytes -> Int32 in
                sqlite3_bind_blob(statement, 2, bytes.baseAddress, Int32(bytes.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            }
            guard status == SQLITE_OK, sqlite3_step(statement) == SQLITE_DONE else { throw Failure.unavailable }
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
    static func recorder(root: URL?) -> (PreviewDecision, Int?) -> Void {
        guard let root, let store = try? NotificationDiagnostic(root: root), let session = try? store.session() else { return { _, _ in } }
        let correlation = UUID()
        let version = "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"))"
        return { decision, duration in
            // Diagnostic I/O is best effort and never changes notification presentation.
            guard let store = try? NotificationDiagnostic(root: root) else { return }
            try? store.append(.init(version: version, time: Date().timeIntervalSince1970,
                                    correlation: correlation, decision: decision, durationMs: duration), session: session)
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
