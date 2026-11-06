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
    static func post(account: String?, events: [Event], center: NotificationCenter = .default) {
        guard let account, !events.isEmpty else { return }
        center.post(name: Notification.Name("net.processone.fluux.widget-publication"), object: nil,
                    userInfo: ["account": account, "events": events.map {
                        ["decision": $0.decision.rawValue, "time": $0.time] as [String: Any]
                    }])
    }
}
