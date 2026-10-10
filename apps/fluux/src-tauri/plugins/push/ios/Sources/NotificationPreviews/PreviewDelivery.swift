import Foundation
import UserNotifications

/// Deadline and system expiry share one completion gate; only body contains plaintext.
final class PreviewDelivery {
    typealias Engine = (Data, @escaping (PreviewResult?) -> Void) -> (() -> Void)
    private let removeRequests: ([String]) -> Void
    init(removeRequests: @escaping ([String]) -> Void = { identifiers in
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }) {
        self.removeRequests = removeRequests
    }
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?
    private var cancel: (() -> Void)?
    private var ended = false
    private var timer: DispatchWorkItem?

    func begin(_ content: UNNotificationContent, completion: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        guard !ended else { lock.unlock(); return }
        handler = completion; fallback = content
        let deadline = DispatchWorkItem { [weak self] in self?.finish() }
        timer = deadline
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 8, execute: deadline)
    }
    func updateFallback(_ content: UNNotificationContent) {
        lock.lock(); defer { lock.unlock() }
        if !ended { fallback = content }
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
        guard allowed, let snapshot = snapshot, let sender = sender,
              var input = (try? JSONSerialization.jsonObject(with: snapshot)) as? [String: Any],
              input["opt_in"] as? Bool == true,
              let peers = input["peers"] as? [String: Any], peers[sender] != nil else { finish(); return }
        guard isCurrent(snapshot) else { finish(); return }
        guard prepare(&input) else { finish(); return }
        input["sender"] = sender
        input["deadline_ms"] = 7000
        guard let bytes = try? JSONSerialization.data(withJSONObject: input) else { finish(); return }
        let cancellation = engine(bytes) { [weak self] result in
            guard let self = self else { return }
            self.finish(result: result, isCurrent: { isCurrent(snapshot) }, select: select)
        }
        lock.lock()
        if handler == nil { lock.unlock(); cancellation() }
        else { cancel = cancellation; lock.unlock() }
    }
    func finish(result: PreviewResult? = nil, isCurrent: () -> Bool = { false },
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
        let selected = result.flatMap { isCurrent() ? select($0) : nil }
        if let selected = selected, isCurrent(), !selected.removeRequests.isEmpty {
            // Notification-center XPC can block; it must not delay content handoff.
            let identifiers = selected.removeRequests
            let remove = removeRequests
            DispatchQueue.global(qos: .utility).async { remove(identifiers) }
        }
        if let body = selected?.body, isCurrent(), let modified = content.mutableCopy() as? UNMutableNotificationContent {
            modified.body = body
            completion(modified)
        } else { completion(content) }
    }
}
