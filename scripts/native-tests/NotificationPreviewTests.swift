import Foundation
import UserNotifications
@main struct PreviewChecks {
    static func result() -> PreviewResult {
        PreviewResult(events: [PreviewEvent(uid: "u", id: "", kind: "newMessage", body: "synthetic plaintext", mutation: nil, target: nil, text: nil)], complete: true)
    }
    static func main() throws {
        let original = UNMutableNotificationContent()
        original.body = "[OpenPGP-encrypted message]"
        original.threadIdentifier = "synthetic-thread"
        let snapshot = try JSONSerialization.data(withJSONObject: ["opt_in": true, "peers": ["alice@nse.invalid": []]])
        for mode in ["missing", "off", "never", "unknown", "failure", "verified", "purged", "expiry"] {
            let delivery = PreviewDelivery()
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
            if mode == "expiry" { delivery.finish() }
            finish?(mode == "failure" ? nil : Self.result())
            delivery.finish()
            precondition(calls == 1, "completion count: \(mode)")
            precondition(body == (mode == "verified" ? "synthetic plaintext" : original.body), "fallback: \(mode)")
            if finish != nil { precondition(cancelled) }
        }
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
        print("notification preview fallback paths passed")
    }
}
