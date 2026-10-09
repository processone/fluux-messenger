import Foundation
import UserNotifications
@main struct PreviewChecks {
    static func main() throws {
        let original = UNMutableNotificationContent()
        original.body = "[OpenPGP-encrypted message]"
        original.threadIdentifier = "synthetic-thread"
        let snapshot = try JSONSerialization.data(withJSONObject: ["opt_in": true, "peers": ["alice@nse.invalid": []]])
        for mode in ["missing", "off", "never", "unknown", "failure", "verified", "purged", "expiry"] {
            let delivery = PreviewDelivery()
            var calls = 0
            var body = ""
            var finish: ((String?) -> Void)?
            var cancelled = false
            let data = mode == "missing" ? nil : (mode == "off" ? Data("{\"opt_in\":false}".utf8) : snapshot)
            delivery.start(original, snapshot: data, sender: mode == "unknown" ? "unknown@nse.invalid" : "alice@nse.invalid", allowed: mode != "never",
                           isCurrent: { _ in mode != "purged" }, engine: { _, callback in
                finish = callback
                return { cancelled = true }
            }, completion: { result in
                calls += 1; body = result.body
                precondition(result.threadIdentifier == "synthetic-thread")
                precondition(result.userInfo.isEmpty)
            })
            if mode == "expiry" { delivery.finish() }
            finish?(mode == "failure" ? nil : "synthetic plaintext")
            delivery.finish()
            precondition(calls == 1, "completion count: \(mode)")
            precondition(body == (mode == "verified" ? "synthetic plaintext" : original.body), "fallback: \(mode)")
            if finish != nil { precondition(cancelled) }
        }
        let revoked = PreviewDelivery()
        var current = true
        var late: ((String?) -> Void)?
        var revokedCalls = 0
        revoked.start(original, snapshot: snapshot, sender: "alice@nse.invalid", allowed: true,
                      isCurrent: { _ in current }, engine: { _, callback in late = callback; return {} },
                      completion: { result in revokedCalls += 1; precondition(result.body == original.body) })
        current = false
        late?("synthetic plaintext")
        revoked.finish()
        precondition(revokedCalls == 1)
        let pending = PreviewDelivery()
        var calls = 0
        pending.begin(original) { _ in calls += 1 }
        pending.finish()
        pending.start(original, snapshot: snapshot, sender: "alice@nse.invalid", allowed: true,
                      isCurrent: { _ in true }, engine: { _, _ in preconditionFailure("expired must not start") }, completion: { _ in calls += 1 })
        precondition(calls == 1)
        print("notification preview fallback paths passed")
    }
}
