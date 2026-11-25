import Foundation
import Tauri
import UIKit
import WebKit
private struct Haptic: Decodable { let kind: String }
private struct Appearance: Decodable { let style: String?; let background: String? }
class IOSFeedbackPlugin: Plugin {
    private var privacy: PrivacyCover?
    private var hinge: AnyObject?
    private var keyboard: KeyboardReporter?
    private weak var webView: WKWebView?
    override func load(webview: WKWebView) {
        let start = {
            self.webView = webview
            self.privacy = PrivacyCover()
            self.keyboard = KeyboardReporter(webView: webview)
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
                if let background = args.background { self.paintBehindKeyboard(background) }
                invoke.resolve()
            }
        } catch { invoke.reject("Invalid appearance") }
    }
    /// WebKit pans the page up by the keyboard's height, so the strip behind the keyboard's rounded
    /// corners is the web view and its root view, not document content. `#rrggbb` only.
    private func paintBehindKeyboard(_ hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return }
        let color = UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
        webView?.backgroundColor = color
        webView?.window?.rootViewController?.view.backgroundColor = color
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
