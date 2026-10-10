import Foundation
import SQLite3

/// Cross-process union/claim transactions contain identities only, never plaintext or secrets.
final class PreviewLedger {
    static func archiveKey(_ uid: String) -> String { "stanzaId:" + uid }
    static let horizon: TimeInterval = 72 * 3600
    static let retention: TimeInterval = 7 * 24 * 3600
    struct Session: Codable, Equatable {
        var account: String
        var epoch: String
        var revision: String
        var activated: TimeInterval
    }
    struct Fact: Codable {
        var id: String?
        var originId: String?
        var verified: Bool?
        var read = false
        var notified = false
        var metadata = false
        var retracted = false
        var request: String?
        var editTarget: String?
        var recorded: TimeInterval
    }
    static func resolveTarget(_ target: String, facts: [String: Fact]) -> [(key: String, value: Fact)] {
        let verified = facts.filter { $0.key.hasPrefix("stanzaId:") && $0.value.verified == true }
        let tiers = [verified.filter { $0.key == archiveKey(target) }, verified.filter { $0.value.originId == target }, verified.filter { $0.value.id == target }]
        for matches in tiers where !matches.isEmpty {
            return matches.count == 1 ? matches.map { ($0.key, $0.value) } : []
        }
        return []
    }
    static func requests(for target: String, facts: [String: Fact]) -> Set<String> {
        Set(facts.compactMap { key, fact in
            key == target || fact.editTarget == target ? fact.request : nil
        })
    }
    private struct State: Codable {
        var version = 1
        var session: Session?
        var clock: TimeInterval = 0
        var disabledUntil: TimeInterval = 0
        var conversations: [String: [String: Fact]] = [:]
    }
    struct Delta: Decodable {
        let account: String
        let epoch: String
        let conversation: String
        let uid: String?
        var archiveAuthority: String? = nil
        var key: String? = nil
        let read: Bool
        let notified: Bool
    }
    private var db: OpaquePointer?
    private let conversationLimit: Int
    private let accountLimit: Int
    private(set) var retiredRequests: [String] = []
    enum Failure: Error { case unavailable, invalid, stale, overflow }

    init(root: URL, conversationLimit: Int = 4096, accountLimit: Int = 16384) throws {
        self.conversationLimit = conversationLimit; self.accountLimit = accountLimit
        let url = root.appendingPathComponent("NotificationLedger.sqlite")
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw Failure.unavailable }
        sqlite3_busy_timeout(db, 150)
        try sql("PRAGMA journal_mode=DELETE")
        try sql("PRAGMA secure_delete=ON")
        try sql("PRAGMA max_page_count=2048")
        try sql("CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY CHECK(id=1), state BLOB NOT NULL)")
        try sql("CREATE TABLE IF NOT EXISTS capability (id INTEGER PRIMARY KEY CHECK(id=1), session BLOB NOT NULL)")
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
    }
    deinit { sqlite3_close(db) }
    private func sql(_ text: String) throws {
        guard sqlite3_exec(db, text, nil, nil, nil) == SQLITE_OK else { throw Failure.unavailable }
    }
    private func transaction<T>(now: TimeInterval, _ change: (inout State) throws -> T) throws -> T {
        try sql("BEGIN IMMEDIATE")
        do {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "SELECT state FROM ledger WHERE id=1", -1, &statement, nil) == SQLITE_OK else { throw Failure.unavailable }
            var state = State()
            if sqlite3_step(statement) == SQLITE_ROW {
                let count = Int(sqlite3_column_bytes(statement, 0))
                guard count <= 7 * 1024 * 1024, let bytes = sqlite3_column_blob(statement, 0) else { sqlite3_finalize(statement); throw Failure.invalid }
                let data = Data(bytes: bytes, count: count)
                sqlite3_finalize(statement)
                state = try JSONDecoder().decode(State.self, from: data)
                guard state.version == 1 else { throw Failure.invalid }
            } else { sqlite3_finalize(statement) }
            // A rollback cannot expire identities or move the activation baseline backwards.
            let clock = max(now, state.clock)
            for (conversation, facts) in state.conversations {
                state.conversations[conversation] = facts.filter { clock - $0.value.recorded <= Self.retention }
                if state.conversations[conversation]?.isEmpty == true { state.conversations.removeValue(forKey: conversation) }
            }
            let result = try change(&state)
            state.clock = clock
            let data = try JSONEncoder().encode(state)
            guard data.count <= 7 * 1024 * 1024 else { throw Failure.overflow }
            guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO ledger VALUES (1, ?)", -1, &statement, nil) == SQLITE_OK else { throw Failure.unavailable }
            defer { sqlite3_finalize(statement) }
            let status = data.withUnsafeBytes { bytes -> Int32 in
                sqlite3_bind_blob(statement, 1, bytes.baseAddress, Int32(bytes.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                return sqlite3_step(statement)
            }
            guard status == SQLITE_DONE else { throw Failure.unavailable }
            var header: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO capability VALUES (1, ?)", -1, &header, nil) == SQLITE_OK else { throw Failure.unavailable }
            defer { sqlite3_finalize(header) }
            let session = try JSONEncoder().encode(state.session)
            let updated = session.withUnsafeBytes { bytes -> Int32 in
                sqlite3_bind_blob(header, 1, bytes.baseAddress, Int32(bytes.count), unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                return sqlite3_step(header)
            }
            guard updated == SQLITE_DONE else { throw Failure.unavailable }
            try sql("COMMIT")
            return result
        } catch { try? sql("ROLLBACK"); throw error }
    }
    func capability(account: String?, purge: Bool, now: TimeInterval = Date().timeIntervalSince1970) throws -> Session? {
        var retired: [String] = []
        let session = try transaction(now: now) { state in
            if purge || (account != nil && state.session?.account != account) {
                retired = Array(Set(state.conversations.values.flatMap { $0.values.compactMap { $0.request } }))
                state.conversations = [:]; state.session = nil; state.disabledUntil = 0
            }
            if let account = account {
                guard valid(account), account.contains("@") else { throw Failure.invalid }
                if state.session == nil {
                    state.session = Session(account: account, epoch: UUID().uuidString, revision: "", activated: max(now, state.clock))
                }
            }
            state.session?.revision = UUID().uuidString
            return state.session
        }
        retiredRequests = retired
        return session
    }
    func current() throws -> Session? {
        // Revocation checks never load the message ledger or rewrite/prune history.
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT session FROM capability WHERE id=1", -1, &statement, nil) == SQLITE_OK else { throw Failure.unavailable }
        defer { sqlite3_finalize(statement) }
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW, sqlite3_column_bytes(statement, 0) <= 2048,
              let bytes = sqlite3_column_blob(statement, 0) else { throw Failure.invalid }
        return try JSONDecoder().decode(Session?.self, from: Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0))))
    }
    func knownIDs(session: Session, conversation: String, now: TimeInterval = Date().timeIntervalSince1970) throws -> [String] {
        try transaction(now: now) { state in
            guard state.session == session, now >= state.clock else { throw Failure.stale }
            // Metadata must still be decrypted to reduce edits against unresolved candidates.
            let ids = state.conversations[conversation, default: [:]].compactMap { key, fact -> String? in
                guard key.hasPrefix("stanzaId:"), !fact.metadata, fact.verified == true, fact.read || fact.notified || fact.retracted else { return nil }
                return String(key.dropFirst(9))
            }
            guard ids.count <= 4096, try JSONEncoder().encode(ids).count <= 256 * 1024 else { throw Failure.overflow }
            return ids
        }
    }
    func merge(_ deltas: [Delta], now: TimeInterval = Date().timeIntervalSince1970) throws -> [String] {
        guard deltas.count <= 256 else { throw Failure.invalid }
        return try transaction(now: now) { state in
            let previous = state.conversations
            var removals = Set<String>()
            for delta in deltas {
                guard let session = state.session, session.account == delta.account, session.epoch == delta.epoch else { continue }
                guard let uid = delta.uid, delta.archiveAuthority == session.account, delta.key == Self.archiveKey(uid) else { continue }
                guard valid(delta.conversation), valid(uid) else { throw Failure.invalid }
                let key = "stanzaId:" + uid
                var facts = state.conversations[delta.conversation] ?? [:]
                var fact = facts[key] ?? Fact(recorded: max(now, state.clock))
                if delta.read {
                    removals.formUnion(Self.requests(for: key, facts: facts))
                }
                fact.read = fact.read || delta.read; fact.notified = fact.notified || delta.notified
                facts[key] = fact
                state.conversations[delta.conversation] = facts
            }
            enforceCapacity(&state, previous: previous, now: now)
            return Array(removals)
        }
    }
    func deliverable(_ selection: PreviewSelection, session: Session, conversation: String, now: TimeInterval = Date().timeIntervalSince1970) throws -> Bool {
        try transaction(now: now) { state in
            state.session == session && now >= state.disabledUntil && selection.claimed.allSatisfy { uid in
                guard let fact = state.conversations[conversation]?["stanzaId:" + uid], !fact.read, !fact.retracted else { return false }
                if let target = fact.editTarget {
                    guard let original = state.conversations[conversation]?[target], !original.read, !original.retracted else { return false }
                }
                return true
            }
        }
    }
    func claimApp(_ delta: Delta, request: String, now: TimeInterval = Date().timeIntervalSince1970) throws -> Bool {
        try transaction(now: now) { state in
            guard let session = state.session, session.account == delta.account, session.epoch == delta.epoch,
                  now >= state.clock, now >= session.activated, now >= state.disabledUntil,
                  valid(request), valid(delta.conversation), let uid = delta.uid, valid(uid),
                  delta.archiveAuthority == session.account, delta.key == Self.archiveKey(uid) else { return false }
            let previous = state.conversations
            var facts = state.conversations[delta.conversation] ?? [:]
            let key = "stanzaId:" + uid
            var fact = facts[key] ?? Fact(recorded: max(now, state.clock))
            guard !fact.read, !fact.notified, !fact.retracted,
                  fact.verified == true || !facts.contains(where: { $0.key.hasPrefix("target:") && $0.value.retracted }) else { return false }
            fact.notified = true; fact.request = request
            facts[key] = fact
            state.conversations[delta.conversation] = facts
            enforceCapacity(&state, previous: previous, now: now)
            return now >= state.disabledUntil
        }
    }
    private func enforceCapacity(_ state: inout State, previous: [String: [String: Fact]], now: TimeInterval) {
        if state.conversations.values.contains(where: { $0.count > conversationLimit }) || state.conversations.values.reduce(0, { $0 + $1.count }) > accountLimit {
            state.disabledUntil = max(now, state.clock) + Self.retention
            state.conversations = previous
        }
    }
    func claim(_ result: PreviewResult, session: Session, conversation: String, request: String,
               nickname: String, words: PreviewWords, now: TimeInterval = Date().timeIntervalSince1970) throws -> PreviewSelection {
        try transaction(now: now) { state in
            guard state.session == session, now >= state.clock, now >= session.activated,
                  result.complete, result.events.count <= 100 else { return PreviewSelection() }
            guard valid(conversation), valid(request), result.events.allSatisfy({ valid($0.uid) && ($0.id.isEmpty || valid($0.id)) && ($0.originId.map(valid) ?? true) }) else { throw Failure.invalid }
            let previous = state.conversations
            let suspended = now < state.disabledUntil
            var unresolvedTarget = false
            var facts = state.conversations[conversation] ?? [:]
            let oldFacts = facts
            var candidates: [PreviewEvent] = []
            var metadata: PreviewEvent?
            var removals = Set<String>()
            func matching(_ target: String, in source: [String: Fact]) -> [(key: String, value: Fact)] {
                Self.resolveTarget(target, facts: source)
            }
            for event in result.events where event.kind == "newMessage" {
                let key = "stanzaId:" + event.uid
                var fact = facts[key] ?? Fact(recorded: max(now, state.clock))
                fact.verified = true; fact.id = event.id; fact.originId = event.originId
                facts[key] = fact
            }
            for entry in facts where entry.key.hasPrefix("target:") && entry.value.retracted {
                let target = String(entry.key.dropFirst(7))
                let resolved = matching(target, in: facts)
                if let match = resolved.first {
                    facts[match.key]?.retracted = true
                    removals.formUnion(Self.requests(for: match.key, facts: facts))
                    facts.removeValue(forKey: entry.key)
                }
            }
            candidates = result.events.filter { event in
                guard event.kind == "newMessage", let body = event.body, !body.isEmpty,
                      let fact = facts[Self.archiveKey(event.uid)] else { return false }
                return !fact.read && !fact.notified && !fact.retracted
            }
            for event in result.events {
                let key = "stanzaId:" + event.uid
                var fact = facts[key] ?? Fact(recorded: max(now, state.clock))
                if event.kind == "metadata", let target = event.target, valid(target) {
                    let resolved = matching(target, in: facts)
                    if event.mutation == "retraction" && resolved.isEmpty {
                        facts["target:" + target] = Fact(retracted: true, recorded: max(now, state.clock))
                    }
                    if event.mutation == "edit" || event.mutation == "outerEdit" || event.mutation == "retraction" {
                        guard resolved.count == 1, resolved[0].value.verified == true else {
                            unresolvedTarget = true
                            continue
                        }
                    }
                    let targetRetracted = matching(target, in: facts).contains(where: { $0.value.retracted })
                    if !fact.metadata && !fact.read && !fact.notified && !((event.mutation == "edit" || event.mutation == "outerEdit") && targetRetracted) { metadata = event }
                    fact.metadata = true
                    if event.mutation == "retraction" {
                        facts.removeValue(forKey: "target:" + target)
                        for match in matching(target, in: facts) {
                            removals.formUnion(Self.requests(for: match.key, facts: facts))
                            facts[match.key]?.retracted = true
                        }
                        candidates.removeAll { candidate in resolved.contains { $0.key == "stanzaId:" + candidate.uid } }
                    } else if (event.mutation == "edit" || event.mutation == "outerEdit"), let text = event.text, !text.isEmpty {
                        let targets = candidates.indices.filter { index in resolved.contains { $0.key == "stanzaId:" + candidates[index].uid } }
                        if targets.count == 1 { candidates[targets[0]].body = text }
                    }
                }
                facts[key] = fact
            }
            candidates.removeAll { facts[Self.archiveKey($0.uid)]?.retracted == true }
            if let event = metadata, (event.mutation == "edit" || event.mutation == "outerEdit"), let target = event.target,
               matching(target, in: facts).contains(where: { $0.value.retracted }) { metadata = nil }
            // An unresolved event may retract or replace any candidate in this batch.
            // Without an exact push ID, revealing an older body would claim more than we know.
            if unresolvedTarget || result.events.contains(where: { $0.kind == "unknown" }) { candidates = []; metadata = nil }
            var body: String?
            if candidates.count == 1 { body = candidates[0].body }
            else if !candidates.isEmpty { body = words.format(words.messages, nickname: nickname, count: candidates.count) }
            else if let event = metadata {
                switch event.mutation {
                case "reaction": body = words.format(words.reaction, nickname: nickname, text: event.text ?? "")
                case "edit", "outerEdit": body = words.format(words.edit, nickname: nickname, text: event.text ?? "")
                case "retraction": body = words.format(words.retraction, nickname: nickname)
                default: break
                }
            }
            if suspended {
                state.conversations[conversation] = facts.filter { oldFacts[$0.key] != nil }
                return PreviewSelection(removeRequests: Array(removals))
            }
            // Reserve before the original handler. An uncertain/crashed handoff is never retried.
            for candidate in candidates { facts["stanzaId:" + candidate.uid]?.notified = true; facts["stanzaId:" + candidate.uid]?.request = request }
            if candidates.isEmpty, let event = metadata, body != nil {
                let key = Self.archiveKey(event.uid)
                facts[key]?.notified = true; facts[key]?.request = request
                if event.mutation == "edit" || event.mutation == "outerEdit", let target = event.target {
                    let resolvedKey = matching(target, in: facts).first?.key
                    facts[key]?.editTarget = resolvedKey
                }
            }
            // Unknown events have no handled fact; a future verified replay may resolve them.
            for event in result.events where event.kind == "unknown" { facts["stanzaId:" + event.uid] = oldFacts["stanzaId:" + event.uid] }
            state.conversations[conversation] = facts
            enforceCapacity(&state, previous: previous, now: now)
            if state.disabledUntil > now { return PreviewSelection(removeRequests: Array(removals)) }
            return PreviewSelection(body: body, claimed: candidates.isEmpty ? (body == nil ? [] : metadata.map { [$0.uid] } ?? []) : candidates.map { $0.uid }, removeRequests: Array(removals))
        }
    }
}
private func valid(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 512 && !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
}
