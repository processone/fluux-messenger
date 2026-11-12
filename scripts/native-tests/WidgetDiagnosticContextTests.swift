import Foundation

@main struct WidgetDiagnosticContextChecks {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let account = "private-account@example.test"
        func write(_ file: String, _ value: [String: Any]) throws {
            try JSONSerialization.data(withJSONObject: value).write(to: root.appendingPathComponent(file))
        }
        try write("NotificationNames.json", ["account": account])
        try write("NotificationBadge.json", ["account": account, "unread": ["private-sender@example.test"]])
        try write("UnreadWidget.json", ["account": account, "rows": [["name": "Private fixture body"]]])
        let store = try NotificationDiagnostic(root: root)
        try store.activate()
        let session = try store.session()!
        let now = Date().timeIntervalSince1970
        let historical = NotificationDiagnostic.Entry(version: "fixture", time: now, correlation: UUID(), decision: .widgetAccountMismatch, durationMs: nil)
        try store.append(Array(repeating: historical, count: 217), session: session)
        let writes = WidgetDiagnostic.BadgeWrites()
        let nativeAttempt = writes.received(account: account)
        writes.finished(nativeAttempt, phase: .current)
        func publisher(_ extras: [String: Any] = [:]) throws -> WidgetDiagnostic.Publisher {
            let value: [String: Any] = ["observedAt": Date().timeIntervalSince1970,
                "online": true, "verifying": false, "catchingUp": true, "replaying": true,
                "badgeCommand": "emitted", "badgeAcknowledgement": "pending"]
            return try JSONDecoder().decode(WidgetDiagnostic.Publisher.self,
                from: JSONSerialization.data(withJSONObject: value.merging(extras) { _, new in new }))
        }
        func exported(_ input: WidgetDiagnostic.Publisher?) throws -> (Data, [NotificationDiagnostic.Entry]) {
            let data = try WidgetDiagnostic.export(root: root, publisher: input, badgeWrites: writes)
            return (data, try JSONDecoder().decode([NotificationDiagnostic.Entry].self, from: data))
        }
        let (data, entries) = try exported(publisher())
        let group = Array(entries.suffix(WidgetDiagnostic.Axis.allCases.count + 2))
        let observed = WidgetDiagnostic.observations(in: group)
        precondition(entries.count == 200 && group.first?.decision == .widgetSnapshotBegin && group.last?.decision == .widgetSnapshotEnd)
        precondition(observed[.connection] == .widgetSnapshotOnline && observed[.catchUp] == .widgetSnapshotCatchingUp)
        precondition(observed[.replay] == .widgetSnapshotReplaying && observed[.verification] == .widgetSnapshotNotVerifying)
        precondition(observed[.badgeOwner] == .widgetSnapshotBadgeOwnerMatches && observed[.listOwner] == .widgetSnapshotListOwnerMatches)
        precondition(observed[.command] == .widgetSnapshotBadgeCommandEmitted && observed[.acknowledgement] == .widgetSnapshotBadgeAckPending)
        precondition(observed[.nativeBadge] == .widgetSnapshotNativeBadgeCurrent)
        precondition(Set(group.map(\.correlation)).count == 1 && group[0].correlation != historical.correlation)
        precondition(entries.dropLast(group.count).allSatisfy { $0.decision == .widgetAccountMismatch }, "Current observations must not replace historical decisions")
        let raw = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        let fields: Set<String> = ["version", "time", "correlation", "decision"]
        precondition(raw.allSatisfy { Set($0.keys) == fields })
        let text = String(data: data, encoding: .utf8)!
        for forbidden in [account, "private-sender@example.test", "Private fixture body", "snapshot\"", "owner\""] {
            precondition(!text.contains(forbidden), "Only closed categories, not fixture data, enter the export")
        }
        let stored = try JSONDecoder().decode([NotificationDiagnostic.Entry].self, from: store.export())
        precondition(stored.count == 200 && stored.allSatisfy { $0.decision == .widgetAccountMismatch }, "Current group belongs only to the temporary export copy")
        let (_, next) = try exported(publisher())
        precondition(next.last?.correlation != group.last?.correlation, "Every voluntary export uses a fresh marker")
        func allUnknown(_ value: [WidgetDiagnostic.Axis: PreviewDecision]) -> Bool {
            WidgetDiagnostic.Axis.allCases.allSatisfy { value[$0] == $0.unknown }
        }
        precondition(allUnknown(WidgetDiagnostic.observations(in: Array(group.dropFirst()))))
        precondition(allUnknown(WidgetDiagnostic.observations(in: Array(group.dropLast()))))
        var contradictory = group
        contradictory.insert(.init(version: group[0].version, time: group[0].time, correlation: group[0].correlation,
            decision: .widgetSnapshotOffline, durationMs: nil), at: contradictory.count - 1)
        precondition(WidgetDiagnostic.observations(in: contradictory)[.connection] == .widgetSnapshotConnectionUnknown)
        precondition(WidgetDiagnostic.observations(in: contradictory)[.replay] == .widgetSnapshotReplaying)
        let missing = group.filter { $0.decision != .widgetSnapshotReplaying }
        precondition(WidgetDiagnostic.observations(in: missing)[.replay] == .widgetSnapshotReplayUnknown)
        var mixed = group
        mixed[1] = .init(version: group[1].version, time: group[1].time, correlation: UUID(), decision: .widgetSnapshotOnline, durationMs: nil)
        precondition(allUnknown(WidgetDiagnostic.observations(in: mixed)))
        let (_, stale) = try exported(publisher(["observedAt": now - 10]))
        let staleObservation = WidgetDiagnostic.observations(in: Array(stale.suffix(group.count)))
        precondition(staleObservation[.connection] == .widgetSnapshotConnectionUnknown && staleObservation[.command] == .widgetSnapshotBadgeCommandUnknown)
        let (_, future) = try exported(publisher(["observedAt": now + 100]))
        precondition(WidgetDiagnostic.observations(in: Array(future.suffix(group.count)))[.connection] == .widgetSnapshotConnectionUnknown)
        let (_, impossibleAck) = try exported(publisher(["badgeCommand": "unknown", "badgeAcknowledgement": "accepted"]))
        precondition(WidgetDiagnostic.observations(in: Array(impossibleAck.suffix(group.count)))[.acknowledgement] == .widgetSnapshotBadgeAckUnknown)
        let (_, unavailable) = try exported(nil)
        precondition(WidgetDiagnostic.observations(in: Array(unavailable.suffix(group.count)))[.replay] == .widgetSnapshotReplayUnknown)
        try write("NotificationBadge.json", ["unread": []])
        try write("UnreadWidget.json", ["account": "different-private-owner@example.test"])
        let (_, mismatched) = try exported(publisher())
        let relations = WidgetDiagnostic.observations(in: Array(mismatched.suffix(group.count)))
        precondition(relations[.badgeOwner] == .widgetSnapshotBadgeOwnerMissing && relations[.listOwner] == .widgetSnapshotListOwnerDiffers)
        try FileManager.default.removeItem(at: root.appendingPathComponent("UnreadWidget.json"))
        let (_, absent) = try exported(publisher())
        precondition(WidgetDiagnostic.observations(in: Array(absent.suffix(group.count)))[.listOwner] == .widgetSnapshotListOwnerUnknown)
        precondition(writes.observed(account: "other-private-owner@example.test") == .unknown)
        writes.clear(); writes.finished(nativeAttempt, phase: .written)
        precondition(writes.observed(account: account) == .unknown, "A late old-session completion cannot restore native state")
        for phase in [WidgetDiagnostic.NativeBadge.received, .written, .superseded, .failed] {
            let attempt = writes.received(account: account)
            writes.finished(attempt, phase: phase)
            precondition(writes.observed(account: account) == phase)
        }
        for input in ["{\"account\":\"private\"}", "{\"publisher\":{\"error\":\"private\"}}", "{\"publisher\":{\"badgeCommand\":\"private\"}}"] {
            do {
                _ = try JSONDecoder().decode(WidgetDiagnostic.Arguments.self, from: Data(input.utf8))
                preconditionFailure("Unexpected fields and arbitrary states must be rejected")
            } catch { }
        }
        let sparse = try JSONDecoder().decode(WidgetDiagnostic.Arguments.self, from: Data("{\"publisher\":{}}".utf8))
        let (_, sparseEntries) = try exported(sparse.publisher)
        precondition(WidgetDiagnostic.observations(in: Array(sparseEntries.suffix(group.count)))[.acknowledgement] == .widgetSnapshotBadgeAckUnknown)
        try store.reset(active: false)
        let (_, signedOut) = try exported(publisher())
        let afterExportSession = try store.session()
        precondition(signedOut.isEmpty && afterExportSession == nil, "Export must neither activate nor restore a signed-out session")
        if let path = ProcessInfo.processInfo.environment["FLUUX_WIDGET_DIAGNOSTIC_EXPORT"] {
            try data.write(to: URL(fileURLWithPath: path))
        }
        print("Widget current diagnostics: exact five-field export, closed states, historical separation, unknown/incomplete groups, 200-entry ceiling, transient snapshots and session isolation passed")
    }
}
