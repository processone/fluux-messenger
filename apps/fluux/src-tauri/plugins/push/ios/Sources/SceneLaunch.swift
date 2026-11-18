import Foundation
import Intents
import ObjectiveC
import UIKit

/// Hands Fluux what launched or reopened its scene: a link, or a tapped Siri
/// suggestion ("Send a message to …").
///
/// The host's `TaoSceneDelegate` passes links to the app only through
/// `scene(_:openURLContexts:)`, which UIKit calls while the app runs. A link
/// that launches the closed app arrives instead in the connection options,
/// which the delegate ignores, so this forwards them to that same method.
///
/// iOS hands a donated `INSendMessageIntent` to the scene delegate: in the
/// connection options on a cold launch, through `scene(_:continue:)` otherwise.
/// The delegate keeps only web links from both, so this adds the suggestion as
/// the app's own shortcut link, which the WebView validates and routes like a
/// tap on a Shortcuts conversation.
enum SceneLaunch {
    private static var installed = false
    private static let openURLContexts = NSSelectorFromString("scene:openURLContexts:")

    /// Must run before UIKit connects the first scene.
    static func install() {
        guard !installed, let cls = NSClassFromString("TaoSceneDelegate") else { return }
        installed = true
        hookConnect(cls)
        hookContinue(cls)
    }

    private static func hookConnect(_ cls: AnyClass) {
        let selector = NSSelectorFromString("scene:willConnectToSession:options:")
        typealias Connect = @convention(c) (AnyObject, Selector, UIScene, UISceneSession, UIScene.ConnectionOptions) -> Void
        let original = class_getInstanceMethod(cls, selector).map { unsafeBitCast(method_getImplementation($0), to: Connect.self) }
        let block: @convention(block) (AnyObject, UIScene, UISceneSession, UIScene.ConnectionOptions) -> Void = { this, scene, session, options in
            original?(this, selector, scene, session, options)
            open(options.urlContexts, from: this, in: scene)
            options.userActivities.forEach { open($0) }
        }
        replace(cls, selector, imp_implementationWithBlock(block), "v@:@@@")
    }

    private static func hookContinue(_ cls: AnyClass) {
        let selector = NSSelectorFromString("scene:continueUserActivity:")
        typealias Continue = @convention(c) (AnyObject, Selector, UIScene, NSUserActivity) -> Void
        let original = class_getInstanceMethod(cls, selector).map { unsafeBitCast(method_getImplementation($0), to: Continue.self) }
        let block: @convention(block) (AnyObject, UIScene, NSUserActivity) -> Void = { this, scene, activity in
            original?(this, selector, scene, activity)
            open(activity)
        }
        replace(cls, selector, imp_implementationWithBlock(block), "v@:@@")
    }

    private static func replace(_ cls: AnyClass, _ selector: Selector, _ implementation: IMP, _ types: String) {
        if !class_addMethod(cls, selector, implementation, types), let method = class_getInstanceMethod(cls, selector) {
            method_setImplementation(method, implementation)
        }
    }

    /// Delivers launch links the way UIKit delivers links to the running app, so the
    /// deep link plugin keeps them as the launch URL the WebView reads once it loads.
    /// Calling the delegate itself keeps an `xmpp:` link in Fluux: asking the system
    /// to open it could hand it to another installed XMPP app.
    private static func open(_ contexts: Set<UIOpenURLContext>, from delegate: AnyObject, in scene: UIScene) {
        guard !contexts.isEmpty, let method = class_getInstanceMethod(object_getClass(delegate), openURLContexts) else { return }
        typealias OpenURLContexts = @convention(c) (AnyObject, Selector, UIScene, NSSet) -> Void
        unsafeBitCast(method_getImplementation(method), to: OpenURLContexts.self)(delegate, openURLContexts, scene, contexts as NSSet)
    }

    /// UIKit hands the link to the scene once it is in the foreground, including during a cold launch.
    private static func open(_ activity: NSUserActivity) {
        guard let destination = ShareSuggestions.destination(of: activity.interaction?.intent),
              let scheme = Bundle.main.object(forInfoDictionaryKey: "FluuxAppScheme") as? String,
              let url = ShortcutConversation(destination).url(scheme: scheme) else { return }
        UIApplication.shared.open(url)
    }
}
