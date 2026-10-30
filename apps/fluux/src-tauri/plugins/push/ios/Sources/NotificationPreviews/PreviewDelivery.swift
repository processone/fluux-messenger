import Foundation
import UserNotifications

/// Deadline and system expiry share one completion gate; only body contains plaintext.
final class PreviewDelivery {
    typealias Engine = (Data, @escaping (PreviewResult?) -> Void) -> (() -> Void)
    private let removeRequests: ([String]) -> Void
    private let uptime: () -> TimeInterval
    init(removeRequests: @escaping ([String]) -> Void = { identifiers in
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }, uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.removeRequests = removeRequests
        self.uptime = uptime
    }
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?
    private var cancel: (() -> Void)?
    private var ended = false
    private var timer: DispatchWorkItem?
    private var started = Date()
    private var startedUptime: TimeInterval = 0
    /// Receives each delivery decision, for `PreviewTrace`.
    var diagnostic: (PreviewDecision, Int?) -> Void = { _, _ in }
    var trace: (String) -> Void = { _ in }

    func begin(_ content: UNNotificationContent, completion: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        guard !ended else { lock.unlock(); return }
        handler = completion; fallback = content; started = Date(); startedUptime = uptime()
        let deadline = DispatchWorkItem { [weak self] in self?.finish(expiration: .deadline) }
        timer = deadline
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 8, execute: deadline)
    }
    /// Whether an opted-in snapshot lets the engine look for `sender`'s messages.
    static func covers(_ sender: String, snapshot: Data) -> Bool {
        guard let input = (try? JSONSerialization.jsonObject(with: snapshot)) as? [String: Any],
              input["opt_in"] as? Bool == true,
              let peers = input["peers"] as? [String: Any] else { return false }
        return peers[sender] != nil
    }
    func start(_ content: UNNotificationContent, snapshot: Data?, sender: String?, allowed: Bool,
               isCurrent: @escaping (Data) -> Bool, engine: Engine,
               prepare: @escaping (inout [String: Any]) -> Bool = { _ in true },
               select: @escaping (PreviewResult) -> PreviewSelection = { _ in PreviewSelection() },
               completion: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        guard !ended else { lock.unlock(); return }
        let needsBegin = handler == nil
        lock.unlock()
        if needsBegin { begin(content, completion: completion) }
        guard allowed else { diagnostic(.previewsHidden, nil); trace("no preview, iOS previews set to never"); finish(); return }
        guard let snapshot = snapshot, let sender = sender, Self.covers(sender, snapshot: snapshot),
              var input = (try? JSONSerialization.jsonObject(with: snapshot)) as? [String: Any] else { finish(); return }
        guard isCurrent(snapshot) else { diagnostic(.capabilityChanged, nil); trace("no preview, capability changed"); finish(); return }
        guard prepare(&input) else { diagnostic(.windowUnavailable, nil); trace("no preview, ledger window unavailable"); finish(); return }
        input["sender"] = sender
        // Keep a second for final handoff within the eight-second delivery deadline.
        // Preparation/settings time is part of the budget, not a fresh seven seconds.
        lock.lock()
        let remaining = max(0, 7 - (uptime() - startedUptime))
        lock.unlock()
        input["deadline_ms"] = Int(remaining * 1000)
        guard let bytes = try? JSONSerialization.data(withJSONObject: input) else { finish(); return }
        let cancellation = engine(bytes) { [weak self] result in
            guard let self = self else { return }
            self.finish(result: result, isCurrent: { isCurrent(snapshot) }, select: select)
        }
        lock.lock()
        if handler == nil { lock.unlock(); cancellation() }
        else { cancel = cancellation; lock.unlock() }
    }
    func finish(result: PreviewResult? = nil, expiration: PreviewDecision? = nil, isCurrent: () -> Bool = { false },
                select: (PreviewResult) -> PreviewSelection = { _ in PreviewSelection() }) {
        lock.lock()
        let completion = handler
        let content = fallback
        let cancellation = cancel
        ended = true
        handler = nil; fallback = nil; cancel = nil
        timer?.cancel(); timer = nil
        lock.unlock()
        cancellation?()
        guard let completion = completion, let content = content else { return }
        let elapsed = Int(Date().timeIntervalSince(started) * 1000)
        // Without an archive, keep the transport-safe push content.
        if result?.archiveUnavailable == true, isCurrent() {
            diagnostic(.archiveUnavailable, elapsed)
            trace("push content, archive unavailable, \(elapsed) ms")
            completion(content)
            return
        }
        let selected = result.flatMap { isCurrent() ? select($0) : nil }
        if let selected = selected, isCurrent(), !selected.removeRequests.isEmpty {
            // Notification-center XPC can block; it must not delay content handoff.
            let identifiers = selected.removeRequests
            let remove = removeRequests
            DispatchQueue.global(qos: .utility).async { remove(identifiers) }
        }
        if let body = selected?.body, isCurrent(), let modified = content.mutableCopy() as? UNMutableNotificationContent {
            diagnostic(.preview, elapsed)
            trace("preview, \(result?.events.count ?? 0) events, \(elapsed) ms")
            modified.body = body
            completion(modified)
        } else {
            let reason = result == nil ? "no engine result" : !isCurrent() ? "capability changed"
                : "nothing new to show (\(result?.events.count ?? 0) events)"
            diagnostic(expiration ?? (result == nil ? .noEngineResult : !isCurrent() ? .capabilityChanged : .nothingNew), elapsed)
            trace("fallback, \(reason), \(selected?.removeRequests.count ?? 0) replaced, \(elapsed) ms")
            completion(content)
        }
    }
}
