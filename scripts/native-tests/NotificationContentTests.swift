import Foundation
import UserNotifications

@main struct NotificationContentChecks {
    struct Output: Decodable { let title: String; let body: String; let subtitle: String? }
    struct Input: Decodable {
        let body: String
        let expected: Output
        let name: String?
        let room: Bool?
        let encrypted: Bool?
        let preview: Bool?
        let optIn: Bool?
        let allowed: Bool?
        let expired: Bool?
        let complete: Bool?
        let duplicate: Bool?
        let read: Bool?
        let current: Bool?
        let signedOut: Bool?
        let mismatch: Bool?
        let archiveUnavailable: Bool?
        let failure: Bool?
        let words: PreviewWords?
        let snapshotAccount: String?
        let events: [PreviewEvent]?
    }
    struct Fixture: Decodable { let id: String; let ios: Input? }
    struct Corpus: Decodable { let version: Int; let words: PreviewWords; let cases: [Fixture] }
    static func main() throws {
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        precondition(corpus.version == 1)
        var failures: [String] = []
        var count = 0
        for fixture in corpus.cases {
            guard let input = fixture.ios else { continue }
            count += 1
            let words = input.words ?? corpus.words
            let peer = "alice@example.test"
            let room = "team@conference.example.test"
            let account = "me@example.test"
            let names = SharedNames(contacts: input.name == "" ? [:] : [peer: "Alice"],
                                    rooms: input.room == true ? [room: "Team"] : [:],
                                    account: input.signedOut == true ? nil : account)
            let original = UNMutableNotificationContent()
            original.body = input.body
            original.userInfo = ["from": input.room == true ? room + "/Alice" : peer,
                                 "to": input.mismatch == true ? "other@example.test" : account]
            if let encrypted = input.encrypted { original.userInfo["encrypted"] = encrypted }
            var output: UNNotificationContent?
            if input.preview != true || input.encrypted == false {
                let service = NotificationService()
                service.loadNames = { names }
                service.readSnapshot = { nil }
                service.ledgerRoot = { nil }
                service.didReceive(UNNotificationRequest(identifier: fixture.id, content: original, trigger: nil)) { output = $0 }
            } else {
                // Exercise the native presentation, completion gate and real SQLite reducer with synthetic engine output.
                let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: root) }
                let ledger = try PreviewLedger(root: root)
                let diagnostic = try NotificationDiagnostic(root: root)
                try diagnostic.activate()
                let session = try ledger.capability(account: account, purge: false, now: Date().timeIntervalSince1970)!
                let events = input.events ?? []
                let result = PreviewResult(events: events, complete: input.complete != false, archiveUnavailable: input.archiveUnavailable)
                if input.duplicate == true {
                    _ = try ledger.claim(result, session: session, conversation: peer, request: "prior", nickname: "Alice", words: words, now: Date().timeIntervalSince1970)
                }
                if input.read == true {
                    _ = try ledger.merge([PreviewLedger.Delta(account: account, epoch: session.epoch, conversation: peer, uid: "one", archiveAuthority: account, key: PreviewLedger.archiveKey("one"), read: true, notified: false)], now: Date().timeIntervalSince1970)
                }
                // FLM-294: exercise the real service's fallback policy, not a duplicate wiring.
                let sessionValue = try JSONSerialization.jsonObject(with: JSONEncoder().encode(session))
                let wordsValue = try JSONSerialization.jsonObject(with: JSONEncoder().encode(words))
                let snapshot = try JSONSerialization.data(withJSONObject: ["account": input.snapshotAccount ?? account, "opt_in": input.optIn != false,
                    "peers": [peer: []], "ledger": sessionValue, "words": wordsValue])
                let service = NotificationService()
                service.loadNames = { names }
                var current = true
                service.readSnapshot = { current ? snapshot : nil }
                service.ledgerRoot = { root }
                service.previewsAllowed = { [weak service] complete in
                    if input.expired == true { service?.serviceExtensionTimeWillExpire() }
                    complete(input.allowed != false)
                }
                var fetches = 0
                service.runPreview = { _, _, _, isCurrent, complete in
                    fetches += 1
                    precondition(isCurrent(), "The service must begin with a current capability")
                    if input.current == false {
                        current = false
                        precondition(!isCurrent(), "The worker's service guard must observe mid-lookup revocation")
                    }
                    complete(input.failure == true ? nil : result)
                    return {}
                }
                var completions = 0
                service.didReceive(UNNotificationRequest(identifier: fixture.id, content: original, trigger: nil)) {
                    completions += 1; output = $0
                }
                precondition(completions == 1, fixture.id + ": completion must occur once")
                if input.current == false {
                    precondition(fetches == 1, "Revocation must occur during a lookup, not before it starts")
                    let entries = try JSONDecoder().decode([NotificationDiagnostic.Entry].self, from: diagnostic.export())
                    precondition(entries.contains { $0.decision == .capabilityChanged })
                    print("revoked during lookup: service worker guard rejected the snapshot; delivery recorded capabilityChanged")
                }
            }
            print("\(fixture.id): \(output?.title ?? "nil") / \(output?.body ?? "nil")")
            if output?.title != input.expected.title || output?.body != input.expected.body || output?.subtitle != (input.expected.subtitle ?? "") {
                failures.append("\(fixture.id): expected \(input.expected.title) / \(input.expected.body), got \(output?.title ?? "nil") / \(output?.body ?? "nil")")
            }
        }
        for failure in failures { print(failure) }
        guard failures.isEmpty else { exit(1) }
        print("shared notification content contract: \(count) Swift cases passed")
    }
}
