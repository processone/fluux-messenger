import Foundation
import WidgetKit

/// The desktop adapter reuses the iOS list and disposable avatar mirror. No path comes from IPC:
/// the signed host's metadata selects its App Group, including the isolated development identity.
@available(macOS 14.0, *)
enum DesktopWidgets {
    static let lock = NSLock()

    static func apply(_ operation: String, data: Data, root: URL) throws -> (written: Bool, refresh: Bool) {
        lock.lock()
        defer { lock.unlock() }
        let decoder = JSONDecoder()
        switch operation {
        case "list", "heartbeat":
            if let list = try decoder.decode(UnreadList?.self, from: data) {
                let previous = UnreadList.load(root: root)
                if previous == list { return (false, false) }
                var previousContent = previous
                previousContent?.updated = list.updated
                // Ordinary publication compares content, not its fresh timestamp. Only the
                // separately identified fifteen-minute heartbeat renews an unchanged list.
                if operation == "list", previousContent == list { return (false, false) }
                try list.write(root: root)
                return (true, true)
            } else {
                let hadContent = UnreadList.load(root: root) != nil || SharedNames.load(root: root).account != nil
                try UnreadList.clear(root: root)
                try NotificationMirror.writeNames(SharedNames(), root: root)
                return (true, hadContent)
            }
        case "names":
            let previousAccount = SharedNames.load(root: root).account
            try NotificationMirror.writeNames(decoder.decode(SharedNames.self, from: data), root: root)
            // Read the result: preserveIfEmpty may deliberately retain the current account.
            return (true, previousAccount != SharedNames.load(root: root).account)
        case "avatar":
            return (try NotificationMirror.writeAvatar(decoder.decode(NotificationAvatar.self, from: data), root: root), false)
        default:
            throw CocoaError(.coderInvalidValue)
        }
    }

    /// Account changes must unblock a list waiting for its owner. Other mirror changes prepare
    /// future notification features without spending widget refresh budget.
    static func receive(_ operation: String, data: Data, root: URL, reload: () -> Void = Self.reload) throws -> Bool {
        let result = try apply(operation, data: data, root: root)
        if result.refresh { reload() }
        return result.written
    }

    static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: UnreadList.widgetKind)
    }
}

/// Exported C entry point used only by the optional-library loader, never a static host link.
/// Returns 1 for a write, 0 for no change/rejected avatar and -1 for unavailable storage/invalid input.
@_cdecl("fluux_widgets_apply")
public func fluuxWidgetsApply(_ operation: UnsafePointer<CChar>, _ json: UnsafePointer<CChar>) -> Int32 {
    guard #available(macOS 14.0, *) else { return 0 }
    guard let root = NotificationMirror.root else { return -1 }
    do {
        let written = try DesktopWidgets.receive(String(cString: operation), data: Data(String(cString: json).utf8), root: root)
        return written ? 1 : 0
    } catch { return -1 }
}
