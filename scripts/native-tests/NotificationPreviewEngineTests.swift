import Foundation

// FLM-294, grounded in FLM-293 case 9: run the real asynchronous Swift engine,
// substituting only the Rust network boundary and keychain storage. The two-slot
// FAST server model is not evidence about the installed server or a real iPhone.
private enum Server {
    static var root: URL!
    static let mutex = NSLock()
    static var current = "t0"
    static var next = "t1"
    static var issued = 1
    static var capability = true
    static var stored: PreviewToken? = PreviewToken(account: "me@example.test", userAgentId: "fixture-agent", token: "t1", expiry: "future")
    static var loads = 0
    static var calls = 0
    static var records = 0
    static var deadlines: [Int] = []
    static var refuse = false
    static var hold = false
    static let entered = DispatchSemaphore(value: 0)
    static let release = DispatchSemaphore(value: 0)

    static func requireFileLock(_ name: String = "fast-token.lock") {
        let fd = open(root.appendingPathComponent(name).path, O_RDWR)
        guard fd >= 0 else { print("failed: sign-in began without the shared lock file"); exit(1) }
        defer { close(fd) }
        let result = flock(fd, LOCK_EX | LOCK_NB)
        if result == 0 { flock(fd, LOCK_UN) }
        guard result != 0 && errno == EWOULDBLOCK else {
            print("failed: shared token lock must cover load, network sign-in and recording"); exit(1)
        }
    }
    static func load(_ account: String) -> PreviewToken {
        requireFileLock()
        mutex.lock(); defer { mutex.unlock() }
        requireFileLock("preview-state.lock")
        precondition(account == stored?.account)
        loads += 1
        return stored!
    }
    static func record(_ change: PreviewToken.Change, _ used: PreviewToken) {
        requireFileLock()
        mutex.lock(); defer { mutex.unlock() }
        requireFileLock("preview-state.lock")
        let resolved = PreviewToken.resolve(used: used, stored: stored, snapshotCurrent: capability, change: change)
        precondition(capability, "The worker must reject a revoked generation before calling storage")
        guard let value = resolved else {
            preconditionFailure("A serialized sign-in must record the successor of its own credential")
        }
        stored = value
        records += 1
    }
}

@_cdecl("fluux_nse_new") func fakeNew() -> UnsafeMutableRawPointer { .allocate(byteCount: 1, alignment: 1) }
@_cdecl("fluux_nse_free") func fakeFree(_ handle: UnsafeMutableRawPointer) { handle.deallocate() }
@_cdecl("fluux_nse_cancel") func fakeCancel(_ handle: UnsafeMutableRawPointer) {}
@_cdecl("fluux_nse_preview") func fakePreview(_ handle: UnsafeMutableRawPointer, _ input: UnsafePointer<UInt8>, _ count: Int,
                                             _ output: UnsafeMutablePointer<UInt8>, _ capacity: Int) -> Int {
    Server.requireFileLock()
    let values = try! JSONSerialization.jsonObject(with: Data(bytes: input, count: count)) as! [String: Any]
    Server.mutex.lock()
    let token = values["fast_token"] as! String
    precondition(values["user_agent_id"] as? String == Server.stored?.userAgentId)
    Server.calls += 1
    Server.deadlines.append(values["deadline_ms"] as! Int)
    let refused = Server.refuse
    let accepted = refused || token == Server.current || token == Server.next
    precondition(accepted, "A later lookup must authenticate with a token the server still accepts")
    if token == Server.next { Server.current = Server.next }
    Server.issued += 1
    Server.next = "t\(Server.issued)"
    let issued = Server.next
    let hold = Server.hold
    Server.hold = false
    Server.mutex.unlock()
    if hold {
        Server.entered.signal()
        precondition(Server.release.wait(timeout: .now() + 5) == .success)
    }
    let result = refused ? PreviewResult(events: [], complete: false, tokenRefused: true)
        : PreviewResult(events: [], complete: true, fastToken: IssuedToken(token: issued, expiry: "future"))
    let bytes = try! JSONEncoder().encode(result)
    precondition(bytes.count <= capacity)
    bytes.copyBytes(to: output, count: bytes.count)
    return bytes.count
}

@main struct EngineChecks {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("fluux-signin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        Server.root = root
        let input = Data("{\"deadline_ms\":7000}".utf8)
        let finished = DispatchGroup()
        func run(current: @escaping () -> Bool = { Server.capability }, expectResult: Bool = true, directory: URL? = nil,
                 uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) -> () -> Void {
            finished.enter()
            return NotificationPreviewEngine.run(input, account: "me@example.test", root: directory ?? root,
                isCurrent: current, loadToken: Server.load, recordToken: Server.record, uptime: uptime) { result in
                    precondition((result != nil) == expectResult)
                    finished.leave()
                }
        }
        // Every load, network invocation and store verifies actual file-lock ownership.
        // Eight overlapping requests plus a following request exercise both token slots.
        for _ in 0..<8 { _ = run() }
        precondition(finished.wait(timeout: .now() + 10) == .success)
        _ = run()
        precondition(finished.wait(timeout: .now() + 5) == .success)
        precondition(Server.calls == 9 && Server.records == 9 && Server.stored?.token == Server.next)
        print("burst: 9 sign-ins accepted; every credential load and successor write held the shared lock")

        Server.hold = true
        let cancelActive = run()
        precondition(Server.entered.wait(timeout: .now() + 5) == .success)
        // A second notification expires while waiting for the first lookup's token.
        let cancel = run(expectResult: false)
        cancel()
        // A third notification's capability is already revoked when its turn comes.
        var current = true
        _ = run(current: { current }, expectResult: false)
        current = false
        cancelActive()
        Server.release.signal()
        precondition(finished.wait(timeout: .now() + 5) == .success)
        precondition(Server.calls == 10 && Server.loads == 10 && Server.records == 10)
        print("queued expiry and revocation: no credential load or sign-in; first rotation retained")
        _ = run(expectResult: false, directory: root.appendingPathComponent("missing"))
        precondition(finished.wait(timeout: .now() + 5) == .success)
        precondition(Server.loads == 10 && Server.calls == 10)
        print("unavailable lock: no unlocked sign-in")
        // FLM-294 R6: a monotonic clock stand-in advances while a real worker
        // holds the actual file lock. No sleep or network-timeout guessing is needed.
        for elapsed: TimeInterval in [6.5, 6.9] {
            Server.hold = true
            _ = run()
            precondition(Server.entered.wait(timeout: .now() + 5) == .success)
            let callsBefore = Server.calls
            let loadsBefore = Server.loads
            var clock: TimeInterval = 100
            _ = run(expectResult: elapsed == 6.5, uptime: { clock })
            clock += elapsed
            Server.release.signal()
            precondition(finished.wait(timeout: .now() + 5) == .success)
            if elapsed == 6.5 {
                precondition(Server.calls == callsBefore + 1 && Server.deadlines.last == 500,
                             "Queued sign-in must receive only the remaining 500 ms")
            } else {
                precondition(Server.calls == callsBefore && Server.loads == loadsBefore,
                             "Below 250 ms, skip credential loading and sign-in")
            }
        }
        print("queued budget: 500 ms passed to sign-in; below 250 ms skips credentials and network")
        Server.refuse = true
        finished.enter()
        _ = NotificationPreviewEngine.run(input, account: "me@example.test", root: root, isCurrent: { true },
            loadToken: Server.load, recordToken: Server.record) { result in
                precondition(result?.tokenRefused == true)
                // No other worker is running. Reacquiring here also proves completion is
                // outside the token lock, so normal synchronous callers cannot deadlock.
                PreviewToken.withSignInLock(root: root) {
                    precondition(Server.stored?.token == "" && Server.stored?.expiry == "")
                }
                finished.leave()
            }
        precondition(finished.wait(timeout: .now() + 5) == .success)
        print("refused token cleared before completion; completion can reacquire the shared lock")
        // FLM-294 R1: the app can revoke and delete credentials while a worker
        // remains blocked in actual network-call position under the sign-in lock.
        Server.refuse = false
        Server.stored = PreviewToken(account: "me@example.test", userAgentId: "fixture-agent", token: Server.next, expiry: "future")
        Server.hold = true
        _ = run()
        precondition(Server.entered.wait(timeout: .now() + 5) == .success)
        let recordsBeforeRevoke = Server.records
        let revoked = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            try! PreviewToken.withStateLock(root: root) {
                Server.capability = false
                Server.stored = nil
            }
            revoked.signal()
        }
        let prompt = revoked.wait(timeout: .now() + 1)
        Server.release.signal()
        precondition(finished.wait(timeout: .now() + 5) == .success)
        precondition(prompt == .success, "App revocation must not wait for the network/sign-in lock")
        precondition(Server.stored == nil && Server.records == recordsBeforeRevoke, "Late lookup cannot recreate a deleted credential")
        print("revocation completed while sign-in was blocked; late rotation did not recreate credentials")
        print("passed")
    }
}
