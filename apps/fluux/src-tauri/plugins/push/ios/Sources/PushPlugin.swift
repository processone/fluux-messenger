import Foundation
import ObjectiveC
import Tauri
import UIKit
import UserNotifications
import WebKit

/// Obtains an APNs device token.
///
/// UIKit reports the token only to the application delegate, which Tauri owns,
/// so `load` adds the two registration callbacks to the delegate's class.
///
/// The token can change between launches, so every launch registers again once
/// the user has granted permission, and each token received is emitted as a
/// `token` event for the app to forward to its push app server.
///
/// A tap on a remote or app-posted local notification is kept until the app takes it with
/// `takePendingTap`, and announced with a `tap` event: when the tap launches
/// the app, it arrives before the webview listens.
class PushPlugin: Plugin {
    fileprivate static weak var shared: PushPlugin?
    private typealias Completion = (Result<(token: String, environment: String), Error>) -> Void
    private var pending: [Completion] = []
    private var pendingTap: [String: Any]?
    private var notificationDelegate: RemoteNotificationDelegate?
    // Development diagnostic: launched through `xcrun devicectl device process launch
    // --environment-variables '{"FLUUX_PUSH_PROBE":"1"}'`, the app writes the outcome of its
    // launch registration to Library/Caches/push-probe.txt, readable with `devicectl device copy from`.
    private let probe = ProcessInfo.processInfo.environment["FLUUX_PUSH_PROBE"] == "1"

    private var badge: BadgeState?
    private let mirrorQueue = DispatchQueue(label: "fluux.notification-mirror")

    private var diagnosticTimer: Timer?
    deinit { diagnosticTimer?.invalidate() }
    private func cleanDiagnostic() {
        mirrorQueue.async {
            guard let root = NotificationMirror.root, let store = try? NotificationDiagnostic(root: root) else { return }
            if SharedNames.load(root: root).account == nil { try? store.reset(active: false) }
            else { try? store.activate() }
            _ = try? store.export()
        }
    }
    @objc public func exportNotificationDiagnostic(_ invoke: Invoke) {
        mirrorQueue.async {
            do {
                guard let root = NotificationMirror.root else { throw PushError.sharedContainerUnavailable }
                let data = try NotificationDiagnostic(root: root).export()
                DispatchQueue.main.async {
                    do {
                        guard let presenter = self.manager.viewController else { throw NotificationDiagnostic.Failure.unavailable }
                        try NotificationDiagnosticShare.present(data: data, from: presenter) { invoke.resolve() }
                    } catch { NotificationDiagnosticShare.clear(); invoke.reject("Notification diagnostic unavailable") }
                }
            } catch { invoke.reject("Notification diagnostic unavailable") }
        }
    }

    override func load(webview: WKWebView) {
        PushPlugin.shared = self
        PushPlugin.installDelegateCallbacks()
        notificationDelegate = RemoteNotificationDelegate(wrapping: UNUserNotificationCenter.current().delegate)
        UNUserNotificationCenter.current().delegate = notificationDelegate
        // Pushes raised the badge while the app was suspended; the app's own count
        // stands until catch-up changes it.
        NotificationCenter.default.addObserver(
            self, selector: #selector(restoreBadge), name: UIApplication.didBecomeActiveNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(removeUnattributedPushes), name: UIApplication.didBecomeActiveNotification, object: nil
        )
        NotificationDiagnosticShare.clear()
        cleanDiagnostic()
        diagnosticTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.cleanDiagnostic() }
        registerIfAuthorized()
    }

    @objc public func takePendingTap(_ invoke: Invoke) {
        DispatchQueue.main.async {
            let payload = self.pendingTap
            self.pendingTap = nil
            invoke.resolve(payload.map { ["payload": $0] } ?? [:])
        }
    }

    /// Updates the account-owned notification index shared with the extension.
    @objc public func setSenderNames(_ invoke: Invoke) {
        do {
            let names = try invoke.parseArgs(SharedNames.self)
            mirrorQueue.async {
                do {
                    guard let root = NotificationMirror.root else { throw PushError.sharedContainerUnavailable }
                    if let diagnostic = try? NotificationDiagnostic(root: root) {
                        if SharedNames.load(root: root).account != names.account || names.account == nil {
                            try? diagnostic.reset(active: names.account != nil)
                            DispatchQueue.main.async { NotificationDiagnosticShare.clear() }
                        } else { try? diagnostic.activate() }
                    }
                    ShareSuggestions.update(names, root: root) { error in
                        if let error { invoke.reject(error.localizedDescription) } else { invoke.resolve() }
                    }
                } catch { invoke.reject(error.localizedDescription) }
            }
        } catch { invoke.reject(error.localizedDescription) }
    }

    @objc public func removeConversationDonations(_ invoke: Invoke) {
        do {
            let destination = try invoke.parseArgs(ConversationDestination.self)
            guard destination.isValid else { invoke.reject("Invalid conversation"); return }
            ShareSuggestions.remove(destination) { error in
                if let error { invoke.reject(error.localizedDescription) } else { invoke.resolve() }
            }
        } catch { invoke.reject("Invalid conversation") }
    }

    @objc public func donateConversation(_ invoke: Invoke) {
        do {
            let destination = try invoke.parseArgs(ConversationDestination.self)
            guard destination.isValid, let root = NotificationMirror.root else { invoke.reject("Invalid conversation"); return }
            ShareSuggestions.donate(destination, root: root) { error in
                if let error { invoke.reject(error.localizedDescription) } else { invoke.resolve() }
            }
        } catch { invoke.reject("Invalid conversation") }
    }

    @objc public func setNotificationSound(_ invoke: Invoke) {
        do {
            let settings = try invoke.parseArgs(NotificationSoundSettings.self)
            mirrorQueue.async {
                do {
                    guard let root = NotificationMirror.root else { throw PushError.sharedContainerUnavailable }
                    try settings.write(root: root)
                    invoke.resolve()
                } catch { invoke.reject("Notification sound preference unavailable") }
            }
        } catch { invoke.reject("Invalid notification sound preference") }
    }

    @objc public func setNotificationPreview(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(PreviewArguments.self)
            mirrorQueue.async {
                do {
                    guard let root = NotificationMirror.root else { throw PushError.sharedContainerUnavailable }
                    if args.operation == "fastToken" {
                        guard let account = args.account else { throw PreviewLedger.Failure.invalid }
                        let token = try PreviewToken.withStateLock(root: root) { PreviewToken.load(for: account) }
                        invoke.resolve(["userAgentId": token.userAgentId, "present": !token.token.isEmpty])
                        return
                    }
                    if args.operation == "storeFastToken" {
                        guard let token = args.fastToken, !token.token.isEmpty, token.userAgentId.count >= 32,
                              NotificationPresentation.bareJid(token.account) == token.account else { throw PreviewLedger.Failure.invalid }
                        try PreviewToken.withStateLock(root: root) { try token.save() }
                        invoke.resolve(); return
                    }
                    let ledger = try PreviewLedger(root: root)
                    if args.operation == "claimApp" {
                        guard let delta = args.deltas?.first, args.deltas?.count == 1, let request = args.requestId else { throw PreviewLedger.Failure.invalid }
                        let allowed = try ledger.claimApp(delta, request: request)
                        PreviewTrace.recorder(root: root)(allowed ? .appShown : .appDuplicate, nil)
                        PreviewTrace.note("app notification \(request.prefix(8)): \(allowed ? "shown" : "already shown")")
                        invoke.resolve(["allowed": allowed])
                        return
                    }
                    if args.operation == "merge" {
                        let removals = try ledger.merge(args.deltas ?? [])
                        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: removals)
                        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: removals)
                        invoke.resolve(); return
                    }
                    // Revoke the capability before retiring history or publishing a new revision.
                    var snapshot = args.snapshot.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] }
                    let account = snapshot?["account"] as? String
                    // Revocation shares only the short state lock with worker reads/writes.
                    // It must complete even while an extension holds fast-token.lock on network I/O.
                    var released: PreviewToken?
                    let session = try PreviewToken.withStateLock(root: root, onUnavailable: {
                        // A failed lock must not leave the password/secret-key capability
                        // published after revoke or sign-out. Still report incomplete cleanup.
                        if args.operation == "revoke" || args.operation == "purge" {
                            try PreviewKeychain.write(nil)
                        }
                    }) {
                        try PreviewKeychain.write(nil)
                        if args.operation == "purge" || (account != nil && PreviewToken.stored()?.account != account) {
                            released = PreviewToken.stored().flatMap { $0.token.isEmpty ? nil : $0 }
                            try PreviewToken.delete()
                        }
                        let session = try ledger.capability(account: account, purge: args.operation == "purge")
                        if let session = session, snapshot != nil {
                            snapshot?["ledger"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(session))
                        }
                        let data = try snapshot.map { try JSONSerialization.data(withJSONObject: $0) }
                        try PreviewKeychain.write(data)
                        return session
                    }
                    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ledger.retiredRequests)
                    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ledger.retiredRequests)
                    var result: [String: Any] = session.map { ["account": $0.account, "epoch": $0.epoch] } ?? [:]
                    if let released = released {
                        result["released"] = ["account": released.account, "userAgentId": released.userAgentId, "token": released.token]
                    }
                    invoke.resolve(result)
                } catch {
                    // The domain and code name the failing step, e.g. a keychain OSStatus; never a secret.
                    let failure = error as NSError
                    invoke.reject("Notification preview state unavailable (\(failure.domain) \(failure.code))")
                }
            }
        } catch { invoke.reject("Invalid notification preview snapshot") }
    }

    @objc public func setNotificationAvatar(_ invoke: Invoke) {
        do {
            let avatar = try invoke.parseArgs(NotificationAvatar.self)
            mirrorQueue.async {
                do {
                    guard let root = NotificationMirror.root else { throw PushError.sharedContainerUnavailable }
                    let written = try NotificationMirror.writeAvatar(avatar, root: root)
                    invoke.resolve(["written": written])
                } catch { invoke.reject(error.localizedDescription) }
            }
        } catch { invoke.reject(error.localizedDescription) }
    }

    /// Sets the app icon badge and shares what it counts with the notification
    /// service extension, which raises it on pushes while the app is suspended.
    @objc public func setBadge(_ invoke: Invoke) {
        do {
            let badge = try invoke.parseArgs(BadgeState.self)
            DispatchQueue.main.async {
                self.badge = badge
                self.restoreBadge()
            }
            invoke.resolve()
        } catch {
            invoke.reject(error.localizedDescription)
        }
    }

    /// Removes the delivered notifications of a conversation that was read,
    /// here or on another device.
    @objc public func dismissNotifications(_ invoke: Invoke) {
        do {
            let target = try invoke.parseArgs(DismissTarget.self).target.lowercased()
            let center = UNUserNotificationCenter.current()
            center.getDeliveredNotifications { delivered in
                let identifiers = delivered
                    .filter { NotificationPresentation.conversation(of: $0.request.content.userInfo) == target }
                    .map { $0.request.identifier }
                if !identifiers.isEmpty {
                    center.removeDeliveredNotifications(withIdentifiers: identifiers)
                }
                invoke.resolve()
            }
        } catch {
            invoke.reject(error.localizedDescription)
        }
    }

    /// Removes delivered pushes that name no conversation, such as neutral alerts or a
    /// sender the server withheld: no read can ever clear them. The app's local
    /// notifications are left alone.
    @objc fileprivate func removeUnattributedPushes() {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let identifiers = delivered
                .filter { $0.request.trigger is UNPushNotificationTrigger
                    && NotificationPresentation.conversation(of: $0.request.content.userInfo) == nil }
                .map { $0.request.identifier }
            if !identifiers.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: identifiers)
            }
        }
    }

    /// Puts back the badge the app last set, over what pushes added to it.
    @objc fileprivate func restoreBadge() {
        guard let badge = badge else { return }
        try? PushPlugin.writeShared(badge, to: "NotificationBadge.json")
        let count = badge.unread.count + badge.events
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(count)
        } else {
            UIApplication.shared.applicationIconBadgeNumber = count
        }
    }

    private static func writeShared<T: Encodable>(_ value: T, to name: String) throws {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw PushError.sharedContainerUnavailable
        }
        // A push can arrive while the device is locked, after its first unlock.
        try JSONEncoder().encode(value).write(
            to: root.appendingPathComponent(name),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    fileprivate func didTap(userInfo: [AnyHashable: Any]) {
        let payload = PushPlugin.jsonPayload(userInfo)
        pendingTap = payload
        if probe, let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            writeProbe("tap=\(json)")
        }
        trigger("tap", data: [:])
    }

    /// The JSON-representable part of an APNs payload, keyed by string.
    private static func jsonPayload(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
        var payload: [String: Any] = [:]
        for (key, value) in userInfo {
            guard let key = key as? String else { continue }
            if JSONSerialization.isValidJSONObject([key: value]) {
                payload[key] = value
            }
        }
        return payload
    }

    @objc public func register(_ invoke: Invoke) {
        requestToken { result in
            switch result {
            case .success(let registration):
                invoke.resolve(["token": registration.token, "environment": registration.environment])
            case .failure(let error):
                invoke.reject(error.localizedDescription)
            }
        }
    }

    private func registerIfAuthorized() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            case .notDetermined where self.probe:
                self.requestToken { _ in }
            default:
                break
            }
        }
    }

    private func requestToken(_ completion: @escaping Completion) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                completion(.failure(error))
                return
            }
            guard granted else {
                completion(.failure(PushError.permissionDenied))
                return
            }
            DispatchQueue.main.async {
                self.pending.append(completion)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    private func didRegister(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        let environment = PushPlugin.apsEnvironment()
        trigger("token", data: ["token": hex, "environment": environment])
        writeProbe("token=\(hex) environment=\(environment)")
        flush(.success((token: hex, environment: environment)))
    }

    private func didFail(error: Error) {
        writeProbe("error=\(error.localizedDescription)")
        flush(.failure(error))
    }

    private func writeProbe(_ line: String) {
        guard probe, let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        try? "\(line)\n".write(to: caches.appendingPathComponent("push-probe.txt"), atomically: true, encoding: .utf8)
    }

    private func flush(_ result: Result<(token: String, environment: String), Error>) {
        let completions = pending
        pending.removeAll()
        completions.forEach { $0(result) }
    }

    /// The `aps-environment` the app is signed with. Development and ad hoc
    /// builds embed their provisioning profile; App Store builds do not and
    /// always use production.
    static func apsEnvironment() -> String {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url),
              let text = String(data: raw, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"),
              let end = text.range(of: "</plist>"),
              let plist = text[start.lowerBound..<end.upperBound].data(using: .isoLatin1),
              let profile = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              let entitlements = profile["Entitlements"] as? [String: Any],
              let environment = entitlements["aps-environment"] as? String else {
            return "production"
        }
        return environment
    }

    private static func installDelegateCallbacks() {
        guard let delegate = UIApplication.shared.delegate else { return }
        let cls: AnyClass = type(of: delegate)
        hook(cls, #selector(UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:))) { argument in
            if let token = argument as? Data {
                PushPlugin.shared?.didRegister(token: token)
            }
        }
        hook(cls, #selector(UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:))) { argument in
            if let error = argument as? Error {
                PushPlugin.shared?.didFail(error: error)
            }
        }
    }

    /// Adds `application:<selector>:` to `cls`, chaining to an existing
    /// implementation so a callback the delegate already handles keeps working.
    private static func hook(_ cls: AnyClass, _ selector: Selector, _ callback: @escaping (AnyObject) -> Void) {
        typealias Callback = @convention(c) (AnyObject, Selector, UIApplication, AnyObject) -> Void
        let original = class_getInstanceMethod(cls, selector).map { unsafeBitCast(method_getImplementation($0), to: Callback.self) }
        let block: @convention(block) (AnyObject, UIApplication, AnyObject) -> Void = { this, application, argument in
            original?(this, selector, application, argument)
            callback(argument)
        }
        let implementation = imp_implementationWithBlock(block)
        if !class_addMethod(cls, selector, implementation, "v@:@@"), let method = class_getInstanceMethod(cls, selector) {
            method_setImplementation(method, implementation)
        }
    }
}

/// Sits in front of the notification center delegate set by the notification
/// plugin, which ignores remote notifications and omits local `extra` from tap
/// events. Retain userInfo for those taps; pass local presentation through.
private class RemoteNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    private let wrapped: UNUserNotificationCenterDelegate?

    init(wrapping wrapped: UNUserNotificationCenterDelegate?) {
        self.wrapped = wrapped
    }

    private static func isRemote(_ notification: UNNotification) -> Bool {
        notification.request.trigger is UNPushNotificationTrigger
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // In the foreground the app is connected and posts its own notifications,
        // and counts the message itself.
        if RemoteNotificationDelegate.isRemote(notification) {
            DispatchQueue.main.async { PushPlugin.shared?.restoreBadge() }
            completionHandler([])
        } else if let wrapped = wrapped, wrapped.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
            wrapped.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
        } else {
            completionHandler([])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if RemoteNotificationDelegate.isRemote(response.notification) || userInfo["__EXTRA__"] is [String: Any] {
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                DispatchQueue.main.async { PushPlugin.shared?.didTap(userInfo: userInfo) }
            }
            completionHandler()
        } else if let wrapped = wrapped, wrapped.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
            wrapped.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
        } else {
            completionHandler()
        }
    }
}

private struct DismissTarget: Decodable {
    let target: String
}

/// What the app icon badge counts: `unread.count + events`. Read by the
/// notification service extension.
private struct BadgeState: Codable {
    let unread: [String]
    let events: Int
    let notifyAllRooms: [String]
}

enum PushError: LocalizedError {
    case permissionDenied
    case sharedContainerUnavailable

    var errorDescription: String? {
        switch self {
        case .permissionDenied: return "Notification permission denied"
        case .sharedContainerUnavailable: return "Shared container unavailable"
        }
    }
}

@_cdecl("init_plugin_push")
func initPlugin() -> Plugin { PushPlugin() }

private struct PreviewArguments: Decodable {
    let snapshot: Data?
    let operation: String
    let requestId: String?
    let deltas: [PreviewLedger.Delta]?
    let account: String?
    let fastToken: PreviewToken?
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        operation = try values.decodeIfPresent(String.self, forKey: .operation) ?? "revoke"
        requestId = try values.decodeIfPresent(String.self, forKey: .requestId)
        guard ["publish", "revoke", "purge", "merge", "claimApp", "fastToken", "storeFastToken"].contains(operation) else { throw PreviewLedger.Failure.invalid }
        account = try values.decodeIfPresent(String.self, forKey: .account)
        fastToken = try values.decodeIfPresent(PreviewToken.self, forKey: .fastToken)
        deltas = try values.decodeIfPresent([PreviewLedger.Delta].self, forKey: .deltas)
        if try !values.contains(.snapshot) || values.decodeNil(forKey: .snapshot) { snapshot = nil }
        else { snapshot = try JSONEncoder().encode(values.decode(JSONValue.self, forKey: .snapshot)) }
    }
    enum Keys: CodingKey { case snapshot, operation, deltas, requestId, account, fastToken }
}
private enum JSONValue: Codable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
}
