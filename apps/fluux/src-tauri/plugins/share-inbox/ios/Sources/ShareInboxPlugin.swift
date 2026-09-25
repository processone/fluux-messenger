import Foundation
import Tauri

class ShareInboxPlugin: Plugin {
    @objc public func inboxPath(_ invoke: Invoke) {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FluuxShareGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            invoke.reject("Shared container unavailable")
            return
        }
        invoke.resolve(["path": root.appendingPathComponent("ShareInbox").path])
    }
}
@_cdecl("init_plugin_share_inbox")
func initPlugin() -> Plugin { ShareInboxPlugin() }
