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
                // Identical publications need neither disk work nor a WidgetKit refresh.
                if UnreadList.load(root: root) == list { return false }
                try list.write(root: root)
            } else {
                let hadList = UnreadList.load(root: root) != nil
                try UnreadList.clear(root: root)
                try NotificationMirror.writeNames(SharedNames(), root: root)
                return hadList
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

    /// Mirror writes prepare future notification features but do not spend widget refresh budget.
    /// A timestamp renewal is published only by the app's fifteen-minute heartbeat.
    static func receive(_ operation: String, data: Data, root: URL, reload: () -> Void = Self.reload) throws -> Bool {
        let written = try apply(operation, data: data, root: root)
        if written && operation == "list" { reload() }
        return written
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
        let written = try DesktopWidgets.receive(String(cString: operation), data: Data(String(cString: json).utf8), root: root)
        return written ? 1 : 0
    } catch { return -1 }
}
