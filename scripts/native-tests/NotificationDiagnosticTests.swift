import Foundation

/// FLM-31 approved privacy, retention, logout and concurrent app/extension intent.
@main struct DiagnosticChecks {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try NotificationDiagnostic(root: root)
        func check(_ value: Bool) { assert(value) }
        let now = Date().timeIntervalSince1970
        let version = CommandLine.arguments[1]
        try store.activate()
        let session = try store.session()!
        let correlation = UUID()
        func entry(_ decision: PreviewDecision = .nothingNew, time: TimeInterval = now) -> NotificationDiagnostic.Entry {
            .init(version: version, time: time, correlation: correlation, decision: decision, durationMs: 712)
        }
        for _ in 0..<(NotificationDiagnostic.limit + 17) { try store.append(entry(), session: session, now: now) }
        func entries(at time: TimeInterval = now) throws -> [[String: Any]] {
            try JSONSerialization.jsonObject(with: store.export(now: time)) as! [[String: Any]]
        }
        let bounded = try entries()
        assert(bounded.count == NotificationDiagnostic.limit)
        assert(Set(bounded[0].keys) == Set(["version", "time", "correlation", "decision", "durationMs"]))
        assert(bounded[0]["version"] as? String == version)
        assert(bounded[0]["correlation"] as? String == correlation.uuidString)
        assert(bounded[0]["decision"] as? String == "nothingNew")
        assert(bounded[0]["durationMs"] as? Int == 712)
        check(try entries(at: now + NotificationDiagnostic.lifetime - 1).count == NotificationDiagnostic.limit)
        check(try entries(at: now + NotificationDiagnostic.lifetime).isEmpty)
        // A backdated/future entry cannot survive retention or a clock rollback.
        try store.append(entry(time: now - NotificationDiagnostic.lifetime), session: session, now: now)
        try store.append(entry(time: now + 1), session: session, now: now)
        check(try entries().isEmpty)
        try store.append(entry(.preview), session: session, now: now)
        try store.reset(active: false)
        try store.append(entry(.noEngineResult), session: session, now: now)
        check(try store.session() == nil)
        check(try entries().isEmpty)
        // A new session/account never accepts a late callback from the old extension.
        try store.activate()
        try store.append(entry(), session: session, now: now)
        check(try entries().isEmpty)
        let next = try store.session()!
        assert(next != session)
        let concurrentEntry = entry(.appDuplicate)
        let workers = DispatchGroup()
        for _ in 0..<4 {
            workers.enter()
            DispatchQueue.global().async {
                defer { workers.leave() }
                for _ in 0..<75 {
                    let connection = try! NotificationDiagnostic(root: root)
                    try! connection.append(concurrentEntry, session: next, now: now)
                }
            }
        }
        workers.wait()
        check(try entries().count == NotificationDiagnostic.limit)
        try store.reset(active: false)
        check(try entries().isEmpty)
        print("FLM-31: exact version, time, random marker, decision and duration only; 200-entry cap, 48-hour expiry, logout, stale-session rejection and concurrent writers passed")
    }
}
