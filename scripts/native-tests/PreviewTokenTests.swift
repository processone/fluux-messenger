import Foundation

// FLM-8: the notification extension's FAST token must not be overwritten by a stale run, must be
// cleared when the server refuses it, and must not be recreated after sign-out.
func check(_ condition: Bool, _ message: String) {
    if !condition { FileHandle.standardError.write(Data("failed: \(message)\n".utf8)); exit(1) }
}

@main struct PreviewTokenChecks {
    static func main() throws {
        let account = "alice@example.com"
        let agent = "8a1f5c1e-2f7b-4d8e-9b0a-3c4d5e6f7a8b"
        func token(_ value: String) -> PreviewToken {
            PreviewToken(account: account, userAgentId: agent, token: value, expiry: value.isEmpty ? "" : "2026-11-20T00:00:00Z")
        }
        let rotate = PreviewToken.Change.rotate(token: "t2", expiry: "2026-12-01T00:00:00Z")

        // A run stores the successor of the token it used.
        let rotated = PreviewToken.resolve(used: token("t1"), stored: token("t1"), snapshotCurrent: true, change: rotate)
        check(rotated?.token == "t2" && rotated?.expiry == "2026-12-01T00:00:00Z" && rotated?.userAgentId == agent, "rotation stores the successor")

        // A run that lost a race to a newer token leaves it alone, for a rotation and for a refusal.
        check(PreviewToken.resolve(used: token("t1"), stored: token("t3"), snapshotCurrent: true, change: rotate) == nil, "stale rotation is dropped")
        check(PreviewToken.resolve(used: token("t1"), stored: token("t3"), snapshotCurrent: true, change: .clear) == nil, "stale refusal keeps the newer token")

        // A refused token is cleared but its user agent is kept for the next token request.
        let cleared = PreviewToken.resolve(used: token("t1"), stored: token("t1"), snapshotCurrent: true, change: .clear)
        check(cleared?.token == "" && cleared?.expiry == "" && cleared?.userAgentId == agent, "refused token is cleared")
        check(PreviewToken.resolve(used: token(""), stored: token(""), snapshotCurrent: true, change: .clear) == nil, "nothing to clear")

        // After a sign-out deleted the token, a finishing run does not bring it back.
        check(PreviewToken.resolve(used: token("t1"), stored: nil, snapshotCurrent: true, change: rotate) == nil, "no token after sign-out")
        check(PreviewToken.resolve(used: token("t1"), stored: nil, snapshotCurrent: false, change: rotate) == nil, "no token without capability")
        // Another account's token is not touched.
        var other = token("t1"); other = PreviewToken(account: "bob@example.com", userAgentId: agent, token: "t1", expiry: "x")
        check(PreviewToken.resolve(used: token("t1"), stored: other, snapshotCurrent: true, change: rotate) == nil, "other account untouched")

        // The very first token is stored only while the capability is still published.
        check(PreviewToken.resolve(used: token(""), stored: nil, snapshotCurrent: true, change: rotate)?.token == "t2", "first token stored")
        check(PreviewToken.resolve(used: token(""), stored: nil, snapshotCurrent: false, change: rotate) == nil, "first token refused after revoke")

        // The lock serialises critical sections across threads (and processes sharing the file).
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("fluux-token-lock-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var counter = 0
        var overlap = false
        var inside = false
        let group = DispatchGroup()
        for _ in 0..<8 {
            group.enter()
            DispatchQueue.global().async {
                for _ in 0..<50 {
                    try! PreviewToken.withStateLock(root: root) {
                        if inside { overlap = true }
                        inside = true
                        let value = counter
                        usleep(10)
                        counter = value + 1
                        inside = false
                    }
                }
                group.leave()
            }
        }
        group.wait()
        check(!overlap && counter == 400, "lock serialises critical sections (counter \(counter))")
        var ranUnlocked = false
        do {
            try PreviewToken.withStateLock(root: root.appendingPathComponent("missing")) { ranUnlocked = true }
            check(false, "missing state lock must fail")
        } catch PreviewToken.LockFailure.unavailable {}
        check(!ranUnlocked, "missing state lock never runs an unlocked transaction")
        // FLM-294 S2 / selected R1: lock failure must not leave a revoked capability
        // published. Model the keychain as isolated bytes; no Security API is called.
        let blocked = root.appendingPathComponent("blocked")
        try FileManager.default.createDirectory(at: blocked.appendingPathComponent("preview-state.lock"), withIntermediateDirectories: true)
        let published = Data("{\"account\":\"alice@example.com\",\"opt_in\":true}".utf8)
        for operation in ["publish", "revoke", "purge"] {
            var capability: Data? = published
            var ranTransaction = false
            do {
                try PreviewToken.withStateLock(root: blocked, onUnavailable: {
                    if operation == "revoke" || operation == "purge" { capability = nil }
                }) {
                    ranTransaction = true
                }
                check(false, "unavailable lock must still report incomplete cleanup: \(operation)")
            } catch PreviewToken.LockFailure.unavailable {}
            check(!ranTransaction, "state transaction never runs unlocked: \(operation)")
            check((capability == nil) == (operation != "publish"), "only revocation deletes the capability without the lock: \(operation)")
        }
        var lockedTransaction = false
        try PreviewToken.withStateLock(root: root, onUnavailable: { check(false, "healthy lock must not use the fallback") }) {
            lockedTransaction = true
        }
        check(lockedTransaction, "healthy state transaction still runs")
        print("unavailable state lock: publish refused; revoke/purge delete capability and report incomplete cleanup")
        // FLM-294 R1: no late token write after revocation, even if cleanup retains
        // the old token temporarily. Rotation and refusal obey the same capability check.
        check(PreviewToken.resolve(used: token("t1"), stored: token("t1"), snapshotCurrent: false, change: rotate) == nil,
              "revocation rejects a late successor")
        check(PreviewToken.resolve(used: token("t1"), stored: token("t1"), snapshotCurrent: false, change: .clear) == nil,
              "revocation rejects a late refusal write")

        print("passed")

    }
}
