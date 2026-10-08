import Foundation
import Tauri
import UIKit

private struct Task: Decodable {
    let id: Int
}

/// Wraps `UIApplication.beginBackgroundTask`, which keeps the app running for a
/// limited time after it leaves the foreground.
///
/// iOS terminates an app that still holds a task when the time runs out, so the
/// expiration handler ends the task itself if the web side has not. Tasks are
/// only touched on the main thread.
class BackgroundTaskPlugin: Plugin {
    private var running = Set<UIBackgroundTaskIdentifier>()

    @objc public func begin(_ invoke: Invoke) {
        DispatchQueue.main.async {
            var id = UIBackgroundTaskIdentifier.invalid
            id = UIApplication.shared.beginBackgroundTask(withName: "Finish sending") { [weak self] in
                self?.finish(id)
            }
            if id != .invalid {
                self.running.insert(id)
            }
            invoke.resolve(["id": id.rawValue])
        }
    }

    @objc public func end(_ invoke: Invoke) {
        let task: Task
        do {
            task = try invoke.parseArgs(Task.self)
        } catch {
            invoke.reject(error.localizedDescription)
            return
        }
        DispatchQueue.main.async {
            self.finish(UIBackgroundTaskIdentifier(rawValue: task.id))
            invoke.resolve()
        }
    }

    private func finish(_ id: UIBackgroundTaskIdentifier) {
        guard running.remove(id) != nil else { return }
        UIApplication.shared.endBackgroundTask(id)
    }
}

@_cdecl("init_plugin_background_task")
func initPlugin() -> Plugin { BackgroundTaskPlugin() }
