import Foundation
import Tauri
import UIKit
import WebKit
#if canImport(WidgetKit)
import WidgetKit
#endif

private struct UnreadListArguments: Decodable { let list: UnreadList? }

/// Writes the widget's unread list into the App Group folder and asks WidgetKit to redraw it.
class WidgetsPlugin: Plugin {
    private let queue = DispatchQueue(label: "net.processone.fluux.widgets")

    override func load(webview: WKWebView) {
        // WidgetKit budgets reloads asked for in the background, not those asked for in the foreground:
        // one more as the app leaves covers what the foreground writes already requested.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { _ in WidgetsPlugin.reload() }
    }

    @objc public func setUnreadList(_ invoke: Invoke) {
        do {
            let list = try invoke.parseArgs(UnreadListArguments.self).list
            queue.async {
                do {
                    guard let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String,
                          let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
                        throw WidgetsError.sharedContainerUnavailable
                    }
                    if let list = list { try list.write(root: root) } else { try UnreadList.clear(root: root) }
                    WidgetsPlugin.reload()
                    invoke.resolve()
                } catch { invoke.reject(error.localizedDescription) }
            }
        } catch { invoke.reject(error.localizedDescription) }
    }

    private static func reload() {
        #if canImport(WidgetKit)
        if #available(iOS 14.0, *) { WidgetCenter.shared.reloadTimelines(ofKind: UnreadList.widgetKind) }
        #endif
    }
}

enum WidgetsError: LocalizedError {
    case sharedContainerUnavailable

    var errorDescription: String? { "Shared container unavailable" }
}

@_cdecl("init_plugin_widgets")
func initPlugin() -> Plugin { WidgetsPlugin() }
