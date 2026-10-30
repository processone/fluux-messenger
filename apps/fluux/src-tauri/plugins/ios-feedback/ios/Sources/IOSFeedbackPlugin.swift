import Foundation
import Tauri
import UIKit
import WebKit
private struct Haptic: Decodable { let kind: String }
private struct Appearance: Decodable { let style: String? }
class IOSFeedbackPlugin: Plugin {
    private var privacy: PrivacyCover?
    private var hinge: AnyObject?
    override func load(webview: WKWebView) {
        let start = {
            self.privacy = PrivacyCover()
            #if canImport(UIKit, _version: 9127.0.85)
            if #available(iOS 27.1, *) { self.hinge = HingeReporter(webView: webview) }
            #endif
        }
        if Thread.isMainThread { start() } else { DispatchQueue.main.sync(execute: start) }
    }
    @objc public func setAppearance(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(Appearance.self)
            let style: UIUserInterfaceStyle
            switch args.style {
            case nil: style = .unspecified
            case "light": style = .light
            case "dark": style = .dark
            default: invoke.reject("Invalid appearance"); return
            }
            DispatchQueue.main.async {
                self.privacy?.appearance = style
                invoke.resolve()
            }
        } catch { invoke.reject("Invalid appearance") }
    }
    @objc public func haptic(_ invoke: Invoke) {
        do {
            let args = try invoke.parseArgs(Haptic.self)
            guard ["contextMenu", "selection"].contains(args.kind) else { invoke.reject("Invalid haptic"); return }
            DispatchQueue.main.async {
                guard UIApplication.shared.applicationState == .active else { invoke.resolve(); return }
                if args.kind == "selection" { UISelectionFeedbackGenerator().selectionChanged() }
                else { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
                invoke.resolve()
            }
        } catch { invoke.reject("Invalid haptic") }
    }
}
@_cdecl("init_plugin_ios_feedback")
func initPlugin() -> Plugin { IOSFeedbackPlugin() }
