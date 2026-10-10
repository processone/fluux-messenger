import Foundation
import Tauri
import UIKit
import WebKit
private struct Haptic: Decodable { let kind: String }
class IOSFeedbackPlugin: Plugin {
    private var privacy: PrivacyCover?
    override func load(webview: WKWebView) {
        if Thread.isMainThread { privacy = PrivacyCover() }
        else { DispatchQueue.main.sync { self.privacy = PrivacyCover() } }
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
