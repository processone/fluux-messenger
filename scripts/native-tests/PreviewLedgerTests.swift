import Foundation

@main struct LedgerChecks {
    static func require(_ value: Bool, _ message: String = "", line: UInt = #line) { precondition(value, "line \(line): " + message) }
    static let words = PreviewWords(activity: "New activity", reaction: "{{nickname}} reacted: {{text}}", edit: "{{nickname}} (edit): {{text}}", retraction: "{{nickname}} deleted a message", messages: "{{nickname}}: {{count}} new messages")
    static func message(_ uid: String, alias: String? = nil, body: String = "synthetic private text") -> PreviewEvent {
        PreviewEvent(uid: uid, id: alias ?? uid, kind: "newMessage", body: body, mutation: nil, target: nil, text: nil)
    }
    static func metadata(_ uid: String, _ mutation: String, _ target: String, _ text: String = "") -> PreviewEvent {
        PreviewEvent(uid: uid, id: uid, kind: "metadata", body: nil, mutation: mutation, target: target, text: text)
    }
    static func main() throws {
        struct Identity: Decodable { let uid: String; let id: String; let originId: String?; let key: String }
        struct Step: Decodable { let body: String?; let claimed: [String]; let removeRequests: [String]; let handoffs: [Bool] }
        struct Fixture: Decodable { let messages: [Identity]; let target: String; let resolved: String?; let batches: [[PreviewEvent]]?; let steps: [Step]? }
        struct Corpus: Decodable { let version: Int; let cases: [Fixture] }
        let input = CommandLine.arguments[1] == "-" ? FileHandle.standardInput.readDataToEndOfFile() : try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let corpus = try JSONDecoder().decode(Corpus.self, from: input)
        require(corpus.version == 1)
        let fixtures = corpus.cases
        for fixture in fixtures {
            if let batches = fixture.batches, let steps = fixture.steps {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: directory) }
                let db = try PreviewLedger(root: directory)
                let bound = try db.capability(account: "me@example.com", purge: false, now: 100)!
                var selections: [PreviewSelection] = []
                for (index, events) in batches.enumerated() {
                    let selection = try db.claim(PreviewResult(events: events, complete: true), session: bound, conversation: "alice@example.com", request: "request-\(index)", nickname: "Alice", words: words, now: 100)
                    if !selection.claimed.isEmpty { selections.append(selection) }
                    require(selection.removeRequests.sorted() == steps[index].removeRequests)
                    let handoffs = try selections.map { try db.deliverable($0, session: bound, conversation: "alice@example.com", now: 100) }
                    require(handoffs == steps[index].handoffs)
                    require(selection.body == steps[index].body, "shared sequence body at \(index)")
                    require(selection.claimed == steps[index].claimed, "shared sequence claims at \(index)")
                }
            }
            var facts: [String: PreviewLedger.Fact] = [:]
            for message in fixture.messages where !message.uid.isEmpty {
                require(PreviewLedger.archiveKey(message.uid) == message.key)
                facts[message.key] = PreviewLedger.Fact(id: message.id, originId: message.originId, verified: true, recorded: 100)
            }
            let resolved = PreviewLedger.resolveTarget(fixture.target, facts: facts)
            require(resolved.first?.key == fixture.resolved.map(PreviewLedger.archiveKey))
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let ledger = try PreviewLedger(root: root)
        let second = try PreviewLedger(root: root)
        let session = try ledger.capability(account: "bob@nse.invalid", purge: false, now: 100)!
        func claim(_ events: [PreviewEvent], _ bound: PreviewLedger.Session = session, _ now: Double = 100, _ db: PreviewLedger? = nil) throws -> PreviewSelection {
            try (db ?? ledger).claim(PreviewResult(events: events, complete: true), session: bound, conversation: "alice@nse.invalid", request: "original-" + (events.first?.uid ?? "empty"), nickname: "Alice", words: words, now: now)
        }
        require(try claim([message("reused-one", alias: "reused")]).body != nil)
        require(try claim([message("reused-two", alias: "reused")]).body != nil, "distinct archive IDs do not inherit notification state")
        require(try claim([metadata("ambiguous-edit", "outerEdit", "reused", "unsafe")]).body == nil)
        require(try claim([metadata("unresolved-edit", "outerEdit", "missing", "unsafe")]).body == nil)
        require(try claim([message("unique-archive", alias: "unique-client")]).body != nil)
        require(try claim([metadata("resolved-edit", "outerEdit", "unique-client", "safe")]).body == "Alice (edit): safe")
        let readEdit = try claim([metadata("read-edit", "edit", "unique-archive", "updated")])
        let readRemovals = try ledger.merge([PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "unique-archive", archiveAuthority: session.account, key: PreviewLedger.archiveKey("unique-archive"), read: true, notified: false)], now: 100)
        require(Set(readRemovals) == Set(["original-unique-archive", "original-resolved-edit", "original-read-edit"]))
        require(try !ledger.deliverable(readEdit, session: session, conversation: "alice@nse.invalid", now: 100))
        require(try claim([message("one"), message("two")]).body == "Alice: 2 new messages")
        require(try claim([message("two"), message("three")], session, 100, second).body == "synthetic private text", "coalesced pushes select only new IDs")
        require(try claim([message("one"), message("two"), message("three")]).body == nil, "repeated push cannot repeat a preview")
        _ = try ledger.capability(account: nil, purge: false, now: 101)
        let refreshed = try ledger.capability(account: "bob@nse.invalid", purge: false, now: 101)!
        require(refreshed.epoch == session.epoch && refreshed.activated == session.activated, "routine key refresh retains progress")
        require(try claim([message("one")], refreshed, 101).body == nil)
        _ = try ledger.merge([PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "older-app-seed", archiveAuthority: session.account, key: PreviewLedger.archiveKey("older-app-seed"), read: true, notified: false)], now: 101)
        require(try claim([message("two"), message("older-app-seed")], refreshed, 101).body == nil, "older seed unions rather than rewinding")
        require(try claim([message("z"), message("a"), message("m")], refreshed, 101).body == "Alice: 3 new messages", "opaque UID order does not stall")
        require(try claim([message("clock-skew")], refreshed, 101).body != nil, "no authored timestamps control progress")
        require(try claim([message("new"), metadata("reaction", "reaction", "new", "👍 ❤️")], refreshed, 102).body == "synthetic private text", "metadata after a message cannot hide the new candidate")
        require(try claim([metadata("reaction2", "reaction", "new", "👍")], refreshed, 102).body == "Alice reacted: 👍")
        require(try claim([message("edited"), metadata("edit", "edit", "edited", "updated")], refreshed, 102).body == "updated")
        let deleted = try claim([message("deleted"), metadata("delete", "retraction", "deleted")], refreshed, 102)
        require(deleted.body == "Alice deleted a message", "never disclose a retracted body")
        require(try claim([message("deleted")], refreshed, 102).body == nil, "tombstone survives overlap")
        require(try claim([metadata("edit-retracted", "edit", "deleted", "must stay hidden")], refreshed, 102).body == nil, "later edit cannot resurrect a retracted body")
        require(try claim([message("reverse-target"), metadata("reverse-edit", "edit", "reverse-target", "must stay hidden"), metadata("reverse-delete", "retraction", "reverse-target")], refreshed, 102).body == "Alice deleted a message")
        let unknown = PreviewEvent(uid: "unresolved", id: "", kind: "unknown", body: nil, mutation: nil, target: nil, text: nil)
        require(try claim([message("withheld"), unknown], refreshed, 102).body == nil, "unknown activity may retract an earlier candidate")
        require(try claim([message("withheld")], refreshed, 102).body != nil, "withheld candidates remain eligible for a verified replay")
        let unknownRetraction = try claim([metadata("known-delete", "retraction", "withheld"), unknown], refreshed, 102)
        require(unknownRetraction.body == nil && unknownRetraction.removeRequests == ["original-withheld"], "verified cancellation still applies beside unknown activity")
        let known = try ledger.knownIDs(session: refreshed, conversation: "alice@nse.invalid", now: 102)
        require(known.contains("one") && known.contains("older-app-seed") && known.contains("withheld"))
        require(!known.contains("reaction2") && !known.contains("edit") && !known.contains("unresolved"), "metadata must be decrypted again to reduce unresolved candidates")
        let handled = PreviewEvent(uid: "one", id: "one", kind: "alreadyHandled", body: nil, mutation: nil, target: nil, text: nil)
        require(try claim([handled, message("after-handled")], refreshed, 102).body != nil, "handled identities do not mask a new message")
        let retract = try claim([metadata("delete-notified", "retraction", "new")], refreshed, 102)
        require(retract.removeRequests == ["original-new"], "retraction targets the grouped original")
        require(try claim([metadata("delete-before", "retraction", "arrives-later"), message("arrives-later")], refreshed, 102).body == "Alice deleted a message")
        require(try claim([message("crash")], refreshed, 102).body != nil)
        require(try claim([message("crash")], refreshed, 102, second).body == nil, "uncertain original handoff is not retried")
        _ = try ledger.merge([PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "archive-read", archiveAuthority: session.account, key: PreviewLedger.archiveKey("archive-read"), read: true, notified: false)], now: 102)
        require(try claim([message("archive-read", alias: "live-read")], refreshed, 102).body == nil, "app read evidence uses the same archive identity")
        let raced = try claim([message("race")], refreshed, 102)
        _ = try second.merge([PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "race", archiveAuthority: session.account, key: PreviewLedger.archiveKey("race"), read: true, notified: false)], now: 102)
        require(try ledger.deliverable(raced, session: refreshed, conversation: "alice@nse.invalid", now: 102) == false, "read between claim and handoff")
        let foreign = PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "foreign", archiveAuthority: "mallory@nse.invalid", key: PreviewLedger.archiveKey("foreign"), read: true, notified: true)
        require(try second.claimApp(foreign, request: "foreign-request", now: 102) == false)
        _ = try second.merge([foreign], now: 102)
        require(try claim([message("foreign")], refreshed, 102).body != nil, "foreign app archive facts are omitted")
        let app = PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "mam-app", archiveAuthority: session.account, key: PreviewLedger.archiveKey("mam-app"), read: false, notified: true)
        require(try second.claimApp(app, request: "app-request", now: 102))
        require(try !ledger.knownIDs(session: refreshed, conversation: "alice@nse.invalid", now: 102).contains("mam-app"), "app records still need NSE verification for metadata targets")
        require(try claim([message("mam-app", alias: "app-first")], refreshed, 102).body == nil, "app and extension share a claim")
        require(try second.claimApp(app, request: "app-request-again", now: 102) == false)
        require(try claim([metadata("app-retract", "retraction", "app-first")], refreshed, 102).removeRequests == ["app-request"])
        let extensionFirst = PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "crash", archiveAuthority: session.account, key: PreviewLedger.archiveKey("crash"), read: false, notified: true)
        require(try second.claimApp(extensionFirst, request: "too-late", now: 102) == false)
        for index in 0..<4 {
            let uid = "concurrent-\(index)"
            let delta = PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: uid, archiveAuthority: session.account, key: PreviewLedger.archiveKey(uid), read: false, notified: true)
            let start = DispatchSemaphore(value: 0)
            let group = DispatchGroup()
            let lock = NSLock()
            var wins = 0
            let jobs: [() -> Bool] = [
                { (try? second.claimApp(delta, request: "app-" + uid, now: 102)) == true },
                { (try? claim([message(uid)], refreshed, 102))?.body != nil },
            ]
            for job in jobs {
                group.enter()
                DispatchQueue.global().async {
                    start.wait()
                    let won = job()
                    lock.lock(); if won { wins += 1 }; lock.unlock()
                    group.leave()
                }
            }
            start.signal(); start.signal()
            require(group.wait(timeout: .now() + 5) == .success)
            require(wins == 1, "concurrent app/extension SQLite transactions have one winner")
        }
        let noArchive = PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: nil, read: false, notified: true)
        require(try second.claimApp(noArchive, request: "no-archive", now: 102) == false)
        require(try claim([metadata("early-client-delete", "retraction", "early-client")], refreshed, 102).body == nil)
        require(try claim([message("later-archive", alias: "early-client")], refreshed, 102).body == nil, "early client tombstone suppresses verified target")
        _ = try claim([metadata("delete-uid-only", "retraction", "uid-only-target")], refreshed, 102)
        let uidOnly = PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "uid-only-target", archiveAuthority: session.account, key: PreviewLedger.archiveKey("uid-only-target"), read: false, notified: true)
        require(try second.claimApp(uidOnly, request: "retracted-app", now: 102) == false, "app claims withhold unverified targets while client tombstones remain unresolved")
        require(try claim([message("rollback")], refreshed, 101).body == nil, "clock rollback is conservative")
        let rollback = PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "app-rollback", archiveAuthority: session.account, key: PreviewLedger.archiveKey("app-rollback"), read: false, notified: true)
        require(try second.claimApp(rollback, request: "backwards-app", now: 101) == false)
        _ = try ledger.capability(account: nil, purge: true, now: 103)
        require(!ledger.retiredRequests.isEmpty, "purge returns pending/delivered requests for cancellation")
        require(try claim([message("late")], refreshed, 103).body == nil, "retired callback cannot restore state")
        let enabled = try ledger.capability(account: session.account, purge: false, now: 104)!
        require(enabled.epoch != session.epoch && enabled.activated == 104)
        require(try claim([message("stale-read")], session, 104).body == nil)
        _ = try ledger.merge([PreviewLedger.Delta(account: session.account, epoch: session.epoch, conversation: "alice@nse.invalid", uid: "stale-read", archiveAuthority: session.account, key: PreviewLedger.archiveKey("stale-read"), read: true, notified: false)], now: 104)
        require(try claim([message("stale-read")], enabled, 104).body != nil, "retired app delta ignored")
        let switched = try ledger.capability(account: "other@nse.invalid", purge: false, now: 105)!
        require(try claim([message("switched")], enabled, 105).body == nil)
        require(try claim([message("switched")], switched, 105).body != nil)
        let bounded = try PreviewLedger(root: root, conversationLimit: 2, accountLimit: 2)
        require(try claim([message("overflow1"), message("overflow2"), message("overflow3")], switched, 105, bounded).body == nil)
        require(try claim([message("switched")], switched, 106, bounded).body == nil, "overflow disables replay rather than evicting to repeat")
        let overflow = PreviewLedger.Delta(account: switched.account, epoch: switched.epoch, conversation: "alice@nse.invalid", uid: "switched", archiveAuthority: switched.account, key: PreviewLedger.archiveKey("switched"), read: false, notified: true)
        require(try bounded.claimApp(overflow, request: "overflow-app", now: 106) == false, "app claims share the overflow replay suspension")
        require(try bounded.knownIDs(session: switched, conversation: "alice@nse.invalid", now: 106).contains("switched"), "suspension permits fetching metadata for cancellation")
        require(try claim([metadata("suspended-delete", "retraction", "switched")], switched, 106, bounded).removeRequests == ["original-switched"], "suspension retains targeted cancellation")
        _ = try bounded.capability(account: nil, purge: true, now: 106)
        require(bounded.retiredRequests.contains("original-switched"), "suspension retains purge cancellation")
        let resumed = try bounded.capability(account: switched.account, purge: false, now: 107)!
        require(try claim([message("fresh-after-retention")], resumed, 105 + PreviewLedger.retention + 1, bounded).body != nil)
        let raw = try Data(contentsOf: root.appendingPathComponent("NotificationLedger.sqlite"))
        require(raw.range(of: Data("synthetic private text".utf8)) == nil, "ledger must not retain plaintext")
        print("shared notification ID ledger regressions passed")
    }
}
