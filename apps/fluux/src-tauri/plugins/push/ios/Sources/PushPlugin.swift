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
class PushPlugin: Plugin {
    private static weak var shared: PushPlugin?
    private typealias Completion = (Result<(token: String, environment: String), Error>) -> Void
    private var pending: [Completion] = []

    override func load(webview: WKWebView) {
        PushPlugin.shared = self
        PushPlugin.installDelegateCallbacks()
        // Development diagnostic: launched through `xcrun devicectl device process launch
        // --environment-variables '{"FLUUX_PUSH_PROBE":"1"}'`, the app registers on its own and
        // writes the outcome to Library/Caches/push-probe.txt, readable with `devicectl device copy from`.
        if ProcessInfo.processInfo.environment["FLUUX_PUSH_PROBE"] == "1" {
            requestToken { result in
                let line: String
                switch result {
                case .success(let registration):
                    line = "token=\(registration.token) environment=\(registration.environment)\n"
                case .failure(let error):
                    line = "error=\(error.localizedDescription)\n"
                }
                if let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
                    try? line.write(to: caches.appendingPathComponent("push-probe.txt"), atomically: true, encoding: .utf8)
                }
            }
        }
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
        flush(.success((token: hex, environment: PushPlugin.apsEnvironment())))
    }

    private func didFail(error: Error) {
        flush(.failure(error))
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

enum PushError: LocalizedError {
    case permissionDenied

    var errorDescription: String? { "Notification permission denied" }
}

@_cdecl("init_plugin_push")
func initPlugin() -> Plugin { PushPlugin() }
