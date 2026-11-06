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
        ) { _ in _ = WidgetsPlugin.reload() }
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
                    if let list = list {
                        switch try list.publish(root: root) {
                        case .current:
                            // Confirmed against the actual file, not a cache of the app's previous call.
                            WidgetPublication.post(account: list.account, events: [], snapshotAt: list.updated / 1000)
                            invoke.resolve(); return
                        case .superseded:
                            // Keep a push that arrived after this app frame was built; do not call it current.
                            invoke.resolve(); return
                        case .written: break
                        }
                    } else { try UnreadList.clear(root: root) }
                    var events = [WidgetPublication.Event(decision: list?.rows.isEmpty == true ? .cleared : .written,
                                                         time: Date().timeIntervalSince1970)]
                    let reloadTime = Date().timeIntervalSince1970
                    if WidgetsPlugin.reload() { events.append(.init(decision: .reloadRequested, time: reloadTime)) }
                    WidgetPublication.post(account: list?.account, events: events, snapshotAt: list.map { $0.updated / 1000 })
                    invoke.resolve()
                } catch {
                    WidgetPublication.post(account: list?.account,
                                           events: [.init(decision: .writeFailed, time: Date().timeIntervalSince1970)])
                    invoke.reject(error.localizedDescription)
                }
            }
        } catch { invoke.reject(error.localizedDescription) }
    }

    private static func reload() -> Bool {
        #if canImport(WidgetKit)
        if #available(iOS 14.0, *) {
            WidgetCenter.shared.reloadTimelines(ofKind: UnreadList.widgetKind)
            return true
        }
        #endif
        return false
    }
}

enum WidgetsError: LocalizedError {
    case sharedContainerUnavailable

    var errorDescription: String? { "Shared container unavailable" }
}

@_cdecl("init_plugin_widgets")
func initPlugin() -> Plugin { WidgetsPlugin() }
