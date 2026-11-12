import Foundation

/// A local diagnostic handoff to the push plugin, which owns the existing journal/export.
/// The account is used only to reject stale-account handoffs; it is never journaled.
enum WidgetPublication {
    enum Decision: String {
        case written = "widgetAppListWritten"
        case cleared = "widgetAppListCleared"
        case writeFailed = "widgetAppWriteFailed"
        case reloadRequested = "widgetAppReloadRequested"
    }
    struct Event {
        let decision: Decision
        let time: TimeInterval
    }
    // A verified-current snapshot can settle a read check without claiming a write or a reload.
    static func post(account: String?, events: [Event], snapshotAt: TimeInterval? = nil, center: NotificationCenter = .default) {
        guard let account, !events.isEmpty || snapshotAt?.isFinite == true else { return }
        var values: [String: Any] = ["account": account, "events": events.map {
            ["decision": $0.decision.rawValue, "time": $0.time] as [String: Any]
        }]
        if let snapshotAt, snapshotAt.isFinite { values["snapshotAt"] = snapshotAt }
        center.post(name: Notification.Name("net.processone.fluux.widget-publication"), object: nil, userInfo: values)
    }
}
