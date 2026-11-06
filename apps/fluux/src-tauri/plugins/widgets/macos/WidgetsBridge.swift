import Foundation
import WidgetKit

/// The desktop adapter reuses the iOS list and disposable avatar mirror. No path comes from IPC:
/// the signed host's metadata selects its App Group, including the isolated development identity.
@available(macOS 14.0, *)
enum DesktopWidgets {
    static let lock = NSLock()

    static func apply(_ operation: String, data: Data, root: URL) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let decoder = JSONDecoder()
        switch operation {
        case "list":
            if let list = try decoder.decode(UnreadList?.self, from: data) {
                // The desktop publisher is the only writer, but keep the shared file's lock contract.
                try list.write(root: root)
            } else {
                try UnreadList.clear(root: root)
                try NotificationMirror.writeNames(SharedNames(), root: root)
            }
        case "names":
            try NotificationMirror.writeNames(decoder.decode(SharedNames.self, from: data), root: root)
        case "avatar":
            return try NotificationMirror.writeAvatar(decoder.decode(NotificationAvatar.self, from: data), root: root)
        default:
            throw CocoaError(.coderInvalidValue)
        }
        return true
    }

    static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: UnreadList.widgetKind)
    }
}

/// Returns 1 for a write, 0 for a rejected avatar and -1 for unavailable storage/invalid input.
@_cdecl("fluux_widgets_apply")
func fluuxWidgetsApply(_ operation: UnsafePointer<CChar>, _ json: UnsafePointer<CChar>) -> Int32 {
    // Older systems keep the app's existing minimum; only the widget needs macOS 14.
    guard #available(macOS 14.0, *) else { return 0 }
    guard let root = NotificationMirror.root else { return -1 }
    do {
        let written = try DesktopWidgets.apply(String(cString: operation), data: Data(String(cString: json).utf8), root: root)
        if written { DesktopWidgets.reload() }
        return written ? 1 : 0
    } catch { return -1 }
}
