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
                let session = try ledger.capability(account: account, purge: false, now: 100)!
                let events = input.events ?? []
                let result = PreviewResult(events: events, complete: input.complete != false, archiveUnavailable: input.archiveUnavailable)
                if input.duplicate == true {
                    _ = try ledger.claim(result, session: session, conversation: peer, request: "prior", nickname: "Alice", words: corpus.words, now: 100)
                }
                if input.read == true {
                    _ = try ledger.merge([PreviewLedger.Delta(account: account, epoch: session.epoch, conversation: peer, uid: "one", archiveAuthority: account, key: PreviewLedger.archiveKey("one"), read: true, notified: false)], now: 100)
                }
                let snapshot = try JSONSerialization.data(withJSONObject: ["opt_in": input.optIn != false, "peers": [peer: []]])
                let content = NotificationPresentation.content(for: original, names: names)
                let fallback = content.mutableCopy() as! UNMutableNotificationContent
                fallback.body = corpus.words.activity
                let delivery = PreviewDelivery(removeRequests: { _ in })
                var completions = 0
                delivery.begin(content) { completions += 1; output = $0 }
                delivery.updateFallback(fallback)
                if input.expired == true { delivery.finish() }
                delivery.start(fallback, snapshot: snapshot, sender: peer, allowed: input.allowed != false,
                               isCurrent: { _ in input.current != false }, engine: { _, complete in complete(result); return {} },
                               select: { result in
                    var selected = (try? ledger.claim(result, session: session, conversation: peer, request: fixture.id, nickname: "Alice", words: corpus.words, now: 100)) ?? PreviewSelection()
                    if (try? ledger.deliverable(selected, session: session, conversation: peer, now: 100)) != true { selected.body = nil }
                    return selected
                }, completion: { _ in preconditionFailure("begin owns completion") })
                delivery.finish()
                precondition(completions == 1, fixture.id + ": completion must occur once")
            }
            if output?.title != input.expected.title || output?.body != input.expected.body || output?.subtitle != (input.expected.subtitle ?? "") {
                failures.append("\(fixture.id): expected \(input.expected.title) / \(input.expected.body), got \(output?.title ?? "nil") / \(output?.body ?? "nil")")
            }
        }
        for failure in failures { print(failure) }
        guard failures.isEmpty else { exit(1) }
        print("shared notification content contract: \(count) Swift cases passed")
    }
}
