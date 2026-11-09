import Foundation

/// Diagnostic-only state. No observation below authorizes a badge/list mutation.
enum WidgetDiagnostic {
    enum Command: String, Decodable { case unknown, emitted }
    enum Acknowledgement: String, Decodable { case unknown, pending, accepted, rejected }
    enum NativeBadge: String { case unknown, received, written, current, superseded, failed }

    struct Publisher: Decodable {
        let observedAt: TimeInterval?
        let online: Bool?
        let verifying: Bool?
        let catchingUp: Bool?
        let replaying: Bool?
        let badgeCommand: Command
        let badgeAcknowledgement: Acknowledgement
        enum Key: String, CodingKey, CaseIterable {
            case observedAt, online, verifying, catchingUp, replaying, badgeCommand, badgeAcknowledgement
        }
        init(from decoder: Decoder) throws {
            try closed(decoder, keys: Key.allCases.map(\.rawValue))
            let values = try decoder.container(keyedBy: Key.self)
            observedAt = try values.decodeIfPresent(TimeInterval.self, forKey: .observedAt)
            online = try values.decodeIfPresent(Bool.self, forKey: .online)
            verifying = try values.decodeIfPresent(Bool.self, forKey: .verifying)
            catchingUp = try values.decodeIfPresent(Bool.self, forKey: .catchingUp)
            replaying = try values.decodeIfPresent(Bool.self, forKey: .replaying)
            badgeCommand = try values.decodeIfPresent(Command.self, forKey: .badgeCommand) ?? .unknown
            badgeAcknowledgement = try values.decodeIfPresent(Acknowledgement.self, forKey: .badgeAcknowledgement) ?? .unknown
        }
    }
    struct Arguments: Decodable {
        let publisher: Publisher?
        enum Key: String, CodingKey { case publisher }
        init(from decoder: Decoder) throws {
            try closed(decoder, keys: ["publisher"])
            publisher = try decoder.container(keyedBy: Key.self).decodeIfPresent(Publisher.self, forKey: .publisher)
        }
    }
    private struct AnyKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    private static func closed(_ decoder: Decoder, keys: [String]) throws {
        let values = try decoder.container(keyedBy: AnyKey.self)
        guard values.allKeys.allSatisfy({ keys.contains($0.stringValue) }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Unsupported diagnostic field"))
        }
    }

    /// One in-memory attempt, invalidated on account/session changes. Never exports its owner or token.
    final class BadgeWrites {
        private let lock = NSLock()
        private var token: UUID?
        private var owner: String?
        private var phase: NativeBadge = .unknown
        func received(account: String?) -> UUID {
            lock.lock(); defer { lock.unlock() }
            let next = UUID()
            token = next; owner = account; phase = .received
            return next
        }
        func finished(_ attempt: UUID, phase next: NativeBadge) {
            lock.lock(); defer { lock.unlock() }
            if token == attempt { phase = next }
        }
        func clear() {
            lock.lock(); defer { lock.unlock() }
            token = nil; owner = nil; phase = .unknown
        }
        func observed(account: String?) -> NativeBadge {
            lock.lock(); defer { lock.unlock() }
            guard let account, owner == account else { return .unknown }
            return phase
        }
    }

    enum Axis: CaseIterable, Hashable {
        case connection, verification, catchUp, replay, badgeOwner, listOwner, command, acknowledgement, nativeBadge
        var categories: [PreviewDecision] {
            switch self {
            case .connection: return [.widgetSnapshotConnectionUnknown, .widgetSnapshotOnline, .widgetSnapshotOffline]
            case .verification: return [.widgetSnapshotVerificationUnknown, .widgetSnapshotVerifying, .widgetSnapshotNotVerifying]
            case .catchUp: return [.widgetSnapshotCatchUpUnknown, .widgetSnapshotCatchingUp, .widgetSnapshotNotCatchingUp]
            case .replay: return [.widgetSnapshotReplayUnknown, .widgetSnapshotReplaying, .widgetSnapshotNotReplaying]
            case .badgeOwner: return [.widgetSnapshotBadgeOwnerUnknown, .widgetSnapshotBadgeOwnerMissing,
                                     .widgetSnapshotBadgeOwnerMatches, .widgetSnapshotBadgeOwnerDiffers]
            case .listOwner: return [.widgetSnapshotListOwnerUnknown, .widgetSnapshotListOwnerMissing,
                                    .widgetSnapshotListOwnerMatches, .widgetSnapshotListOwnerDiffers]
            case .command: return [.widgetSnapshotBadgeCommandUnknown, .widgetSnapshotBadgeCommandEmitted]
            case .acknowledgement: return [.widgetSnapshotBadgeAckUnknown, .widgetSnapshotBadgeAckPending,
                                          .widgetSnapshotBadgeAckAccepted, .widgetSnapshotBadgeAckRejected]
            case .nativeBadge: return [.widgetSnapshotNativeBadgeUnknown, .widgetSnapshotNativeBadgeReceived,
                                      .widgetSnapshotNativeBadgeWritten, .widgetSnapshotNativeBadgeCurrent,
                                      .widgetSnapshotNativeBadgeSuperseded, .widgetSnapshotNativeBadgeFailed]
            }
        }
        var unknown: PreviewDecision { categories[0] }
    }

    /// A partial, mixed or contradictory group is never evidence that an unobserved step ran.
    static func observations(in group: [NotificationDiagnostic.Entry]) -> [Axis: PreviewDecision] {
        let unknown = Dictionary(uniqueKeysWithValues: Axis.allCases.map { ($0, $0.unknown) })
        guard let first = group.first, let last = group.last,
              first.decision == .widgetSnapshotBegin, last.decision == .widgetSnapshotEnd,
              group.allSatisfy({ $0.correlation == first.correlation && $0.version == first.version &&
                                $0.time.isFinite && $0.time >= first.time && $0.time <= last.time }),
              group.dropFirst().dropLast().allSatisfy({ entry in Axis.allCases.contains { $0.categories.contains(entry.decision) } }) else { return unknown }
        var result = unknown
        for axis in Axis.allCases {
            let values = group.filter { axis.categories.contains($0.decision) }
            if values.count == 1 { result[axis] = values[0].decision }
        }
        if result[.command] != .widgetSnapshotBadgeCommandEmitted && result[.acknowledgement] != .widgetSnapshotBadgeAckUnknown {
            result[.command] = Axis.command.unknown
            result[.acknowledgement] = Axis.acknowledgement.unknown
        }
        return result
    }

    private struct Owner: Decodable { let account: String? }
    private static func owner(_ file: String, root: URL) -> Owner? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent(file)) else { return nil }
        return try? JSONDecoder().decode(Owner.self, from: data)
    }
    private static func relation(_ file: String, root: URL, account: String?, axis: Axis) -> PreviewDecision {
        guard let account, let stored = owner(file, root: root) else { return axis.unknown }
        guard let value = stored.account else { return axis.categories[1] }
        return value == account ? axis.categories[2] : axis.categories[3]
    }

    /// The current group exists only in the voluntary share copy, not in another persistent log.
    /// Historical retention is unchanged; the copy reserves room within the same 200-entry ceiling.
    static func export(root: URL, publisher: Publisher?, badgeWrites: BadgeWrites,
                       clock: () -> TimeInterval = { Date().timeIntervalSince1970 }) throws -> Data {
        let store = try NotificationDiagnostic(root: root)
        let session = try store.session()
        let history = try JSONDecoder().decode([NotificationDiagnostic.Entry].self, from: store.export())
        // Export must not reactivate a signed-out diagnostic session.
        guard session != nil, try store.session() == session else { return try store.export() }
        let now = clock()
        // A delayed/missing application observation is unknown, not a fresh native fact.
        let sampledAt = publisher?.observedAt.flatMap { $0.isFinite && $0 <= now && now - $0 <= 5 ? $0 : nil }
        let current = sampledAt == nil ? nil : publisher
        let marker = UUID()
        let version = "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"))"
        func entry(_ decision: PreviewDecision, time: TimeInterval? = nil) -> NotificationDiagnostic.Entry {
            .init(version: version, time: time ?? clock(), correlation: marker, decision: decision, durationMs: nil)
        }
        func flag(_ value: Bool?, axis: Axis) -> NotificationDiagnostic.Entry {
            entry(value.map { axis.categories[$0 ? 1 : 2] } ?? axis.unknown, time: sampledAt)
        }
        var group = [entry(.widgetSnapshotBegin, time: sampledAt ?? now),
                     flag(current?.online, axis: .connection), flag(current?.verifying, axis: .verification),
                     flag(current?.catchingUp, axis: .catchUp), flag(current?.replaying, axis: .replay)]
        let account = owner("NotificationNames.json", root: root)?.account
        group.append(entry(relation("NotificationBadge.json", root: root, account: account, axis: .badgeOwner)))
        group.append(entry(relation("UnreadWidget.json", root: root, account: account, axis: .listOwner)))
        group.append(entry(current?.badgeCommand == .emitted ? .widgetSnapshotBadgeCommandEmitted : .widgetSnapshotBadgeCommandUnknown,
                           time: sampledAt))
        let acknowledgement: PreviewDecision
        switch current?.badgeAcknowledgement {
        case .pending?: acknowledgement = .widgetSnapshotBadgeAckPending
        case .accepted?: acknowledgement = .widgetSnapshotBadgeAckAccepted
        case .rejected?: acknowledgement = .widgetSnapshotBadgeAckRejected
        default: acknowledgement = .widgetSnapshotBadgeAckUnknown
        }
        group.append(entry(acknowledgement, time: sampledAt))
        let phase: PreviewDecision
        switch badgeWrites.observed(account: account) {
        case .received: phase = .widgetSnapshotNativeBadgeReceived
        case .written: phase = .widgetSnapshotNativeBadgeWritten
        case .current: phase = .widgetSnapshotNativeBadgeCurrent
        case .superseded: phase = .widgetSnapshotNativeBadgeSuperseded
        case .failed: phase = .widgetSnapshotNativeBadgeFailed
        case .unknown: phase = .widgetSnapshotNativeBadgeUnknown
        }
        group.append(entry(phase)); group.append(entry(.widgetSnapshotEnd))
        let observations = observations(in: group)
        // Canonicalize malformed/contradictory observations to closed unknown categories.
        group = group.map { item in
            guard let axis = Axis.allCases.first(where: { $0.categories.contains(item.decision) }) else { return item }
            return .init(version: item.version, time: item.time, correlation: item.correlation,
                         decision: observations[axis] ?? axis.unknown, durationMs: nil)
        }
        guard try store.session() == session else { return try store.export() }
        let historical = history.filter { !$0.decision.rawValue.hasPrefix("widgetSnapshot") }
        let result = Array(historical.suffix(NotificationDiagnostic.limit - group.count)) + group
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(result)
    }
}
