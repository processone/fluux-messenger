import Foundation
import UserNotifications
@main struct PreviewChecks {
    static func result() -> PreviewResult {
        PreviewResult(events: [PreviewEvent(uid: "u", id: "", kind: "newMessage", body: "synthetic plaintext", mutation: nil, target: nil, text: nil)], complete: true)
    }
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let diagnostic = try NotificationDiagnostic(root: root)
        try diagnostic.activate()
        let original = UNMutableNotificationContent()
        original.body = "[OpenPGP-encrypted message]"
        original.threadIdentifier = "synthetic-thread"
        let snapshot = try JSONSerialization.data(withJSONObject: ["opt_in": true, "peers": ["alice@nse.invalid": []]])
        for mode in ["missing", "off", "never", "unknown", "failure", "verified", "purged", "expiry", "archive-unavailable"] {
            let delivery = PreviewDelivery()
            // FLM-31: exercise real preview outcomes, not free-form strings or payload logging.
            let record = PreviewTrace.recorder(root: root)
            delivery.diagnostic = record
            var calls = 0
            var body = ""
            var finish: ((PreviewResult?) -> Void)?
            var cancelled = false
            let data = mode == "missing" ? nil : (mode == "off" ? Data("{\"opt_in\":false}".utf8) : snapshot)
            delivery.start(original, snapshot: data, sender: mode == "unknown" ? "unknown@nse.invalid" : "alice@nse.invalid", allowed: mode != "never",
                           isCurrent: { _ in mode != "purged" }, engine: { _, callback in
                finish = callback
                return { cancelled = true }
            }, select: { result in PreviewSelection(body: result.events.first?.body) }, completion: { result in
                calls += 1; body = result.body
                precondition(result.threadIdentifier == "synthetic-thread")
                precondition(result.userInfo.isEmpty)
            })
            if mode == "expiry" { delivery.finish(expiration: .systemExpiry) }
            finish?(mode == "failure" ? nil : mode == "archive-unavailable"
                ? PreviewResult(events: [], complete: false, archiveUnavailable: true) : Self.result())
            delivery.finish()
            precondition(calls == 1, "completion count: \(mode)")
            precondition(body == (mode == "verified" ? "synthetic plaintext" : original.body), "fallback: \(mode)")
            if finish != nil { precondition(cancelled) }
        }
        precondition(PreviewDelivery.covers("alice@nse.invalid", snapshot: snapshot))
        precondition(!PreviewDelivery.covers("unknown@nse.invalid", snapshot: snapshot))
        precondition(!PreviewDelivery.covers("alice@nse.invalid", snapshot: Data("{\"opt_in\":false,\"peers\":{\"alice@nse.invalid\":[]}}".utf8)))
        let revoked = PreviewDelivery()
        var current = true
        var late: ((PreviewResult?) -> Void)?
        var revokedCalls = 0
        revoked.start(original, snapshot: snapshot, sender: "alice@nse.invalid", allowed: true,
                      isCurrent: { _ in current }, engine: { _, callback in late = callback; return {} },
                      completion: { result in revokedCalls += 1; precondition(result.body == original.body) })
        current = false
        late?(Self.result())
        revoked.finish()
        precondition(revokedCalls == 1)
        // FLM-294 R6: setup/settings time consumes the original delivery budget.
        var uptime: TimeInterval = 100
        let delayed = PreviewDelivery(uptime: { uptime })
        var delayedCalls = 0
        delayed.begin(original) { content in
            delayedCalls += 1
            precondition(content.body == original.body)
        }
        uptime = 106
        delayed.start(original, snapshot: snapshot, sender: "alice@nse.invalid", allowed: true,
                      isCurrent: { _ in true }, engine: { input, complete in
            let values = try! JSONSerialization.jsonObject(with: input) as! [String: Any]
            precondition(values["deadline_ms"] as? Int == 1000, "Settings delay must not reset the network budget")
            complete(nil)
            return {}
        }, completion: { _ in preconditionFailure("begin owns completion") })
        precondition(delayedCalls == 1)
        let pending = PreviewDelivery()
        var calls = 0
        pending.begin(original) { _ in calls += 1 }
        pending.finish()
        pending.start(original, snapshot: snapshot, sender: "alice@nse.invalid", allowed: true,
                      isCurrent: { _ in true }, engine: { _, _ in preconditionFailure("expired must not start") }, completion: { _ in calls += 1 })
        precondition(calls == 1)
        let cancellationEntered = DispatchSemaphore(value: 0)
        let releaseCancellation = DispatchSemaphore(value: 0)
        let cancellationFinished = DispatchSemaphore(value: 0)
        let completed = DispatchSemaphore(value: 0)
        let blocked = PreviewDelivery(removeRequests: { identifiers in
            precondition(identifiers == ["original", "edit"])
            cancellationEntered.signal()
            releaseCancellation.wait()
            cancellationFinished.signal()
        })
        blocked.begin(original) { content in
            precondition(content.body == "synthetic retraction")
            precondition(content.threadIdentifier == original.threadIdentifier)
            completed.signal()
        }
        DispatchQueue.global().async {
            blocked.finish(result: Self.result(), isCurrent: { true }, select: { _ in
                PreviewSelection(body: "synthetic retraction", removeRequests: ["original", "edit"])
            })
        }
        precondition(cancellationEntered.wait(timeout: .now() + 2) == .success)
        let completionWhileBlocked = completed.wait(timeout: .now() + 2)
        releaseCancellation.signal()
        precondition(cancellationFinished.wait(timeout: .now() + 2) == .success)
        precondition(completionWhileBlocked == .success, "cancellation blocked delivery completion")
        blocked.finish()
        precondition(completed.wait(timeout: .now() + 0.1) == .timedOut, "duplicate completion")
        let exported = try diagnostic.export()
        let entries = try JSONDecoder().decode([NotificationDiagnostic.Entry].self, from: exported)
        precondition(entries.contains { $0.decision == .archiveUnavailable })
        precondition(entries.contains { $0.decision == .preview })
        precondition(entries.contains { $0.decision == .noEngineResult })
        precondition(entries.contains { $0.decision == .systemExpiry })
        precondition(entries.contains { $0.decision == .previewsHidden })
        precondition(entries.contains { $0.decision == .capabilityChanged })
        let json = String(decoding: exported, as: UTF8.self)
        for privateValue in ["synthetic plaintext", "synthetic-thread", "alice@nse.invalid", "opt_in", "peers"] {
            precondition(!json.contains(privateValue), "payload entered diagnostic")
        }
        print("notification preview fallback paths and content-free export passed")
    }
}
