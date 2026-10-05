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
/// A tap on a remote notification is kept until the app takes it with
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
        registerIfAuthorized()
    }

    @objc public func takePendingTap(_ invoke: Invoke) {
        DispatchQueue.main.async {
            let payload = self.pendingTap
            self.pendingTap = nil
            invoke.resolve(payload.map { ["payload": $0] } ?? [:])
        }
    }

    /// Shares contact and room names with the notification service extension,
    /// which titles each push with its sender's name.
    @objc public func setSenderNames(_ invoke: Invoke) {
        do {
            try PushPlugin.writeShared(try invoke.parseArgs(SenderNames.self), to: "NotificationNames.json")
            invoke.resolve()
        } catch {
            invoke.reject(error.localizedDescription)
        }
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
                    .filter { PushPlugin.conversation(of: $0.request.content.userInfo) == target }
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

    /// The conversation a delivered notification belongs to: the `navTarget`
    /// the app gives its own notifications (the notification plugin keeps
    /// `extra` under `__EXTRA__`), or the bare JID a push comes from.
    private static func conversation(of userInfo: [AnyHashable: Any]) -> String? {
        if let extra = userInfo["__EXTRA__"] as? [String: Any], let target = extra["navTarget"] as? String {
            return target.lowercased()
        }
        if let from = userInfo["from"] as? String {
            return from.split(separator: "/", maxSplits: 1).first.map { $0.lowercased() }
        }
        return nil
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
/// plugin, which ignores remote notifications: it handles taps on those and
/// passes everything else through.
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
        if RemoteNotificationDelegate.isRemote(response.notification) {
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                PushPlugin.shared?.didTap(userInfo: response.notification.request.content.userInfo)
            }
            completionHandler()
        } else if let wrapped = wrapped, wrapped.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
            wrapped.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
        } else {
            completionHandler()
        }
    }
}

/// Display names by bare JID, read by the notification service extension.
private struct SenderNames: Codable {
    let contacts: [String: String]
    let rooms: [String: String]
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
