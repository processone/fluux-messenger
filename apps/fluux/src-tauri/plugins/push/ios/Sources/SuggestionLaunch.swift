import Foundation
import Intents
import ObjectiveC
import UIKit

/// Opens the conversation of a tapped Siri suggestion ("Send a message to …").
///
/// iOS hands the donated `INSendMessageIntent` to the scene delegate: in the
/// connection options on a cold launch, through `scene(_:continue:)` otherwise.
/// The host's `TaoSceneDelegate` keeps only web links from both, so this adds
/// the suggestion as the app's own shortcut link, which the WebView validates
/// and routes like a tap on a Shortcuts conversation.
enum SuggestionLaunch {
    private static var installed = false

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
            options.userActivities.forEach { open($0, in: scene) }
        }
        replace(cls, selector, imp_implementationWithBlock(block), "v@:@@@")
    }

    private static func hookContinue(_ cls: AnyClass) {
        let selector = NSSelectorFromString("scene:continueUserActivity:")
        typealias Continue = @convention(c) (AnyObject, Selector, UIScene, NSUserActivity) -> Void
        let original = class_getInstanceMethod(cls, selector).map { unsafeBitCast(method_getImplementation($0), to: Continue.self) }
        let block: @convention(block) (AnyObject, UIScene, NSUserActivity) -> Void = { this, scene, activity in
            original?(this, selector, scene, activity)
            open(activity, in: scene)
        }
        replace(cls, selector, imp_implementationWithBlock(block), "v@:@@")
    }

    private static func replace(_ cls: AnyClass, _ selector: Selector, _ implementation: IMP, _ types: String) {
        if !class_addMethod(cls, selector, implementation, types), let method = class_getInstanceMethod(cls, selector) {
            method_setImplementation(method, implementation)
        }
    }

    private static func open(_ activity: NSUserActivity, in scene: UIScene) {
        guard let destination = ShareSuggestions.destination(of: activity.interaction?.intent),
              let scheme = Bundle.main.object(forInfoDictionaryKey: "FluuxAppScheme") as? String,
              let url = ShortcutConversation(destination).url(scheme: scheme) else { return }
        whenActive(scene) { UIApplication.shared.open(url) }
    }

    /// UIKit drops a link opened while the scene is still connecting or activating.
    private static func whenActive(_ scene: UIScene, _ work: @escaping () -> Void) {
        if scene.activationState == .foregroundActive { work(); return }
        var token: NSObjectProtocol?
        token = NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: scene, queue: .main) { _ in
            if let token = token { NotificationCenter.default.removeObserver(token) }
            work()
        }
    }
}
