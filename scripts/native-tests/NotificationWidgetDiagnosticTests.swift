import Foundation
import UserNotifications

/// Run the real extension hook, unread-file mutation and SQLite export in disposable storage.
/// No app identity or shared keychain entitlement is installed in this executable.
@main struct WidgetDiagnosticChecks {
    static let account = "fixture@example.com"
    static let sender = "sender@example.com"

    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let scenario = CommandLine.arguments[1]
        let names = SharedNames(contacts: [sender: "Private fixture name"], account: account)
        var list = UnreadList(account: account, total: 0, rows: [], updated: 1)
        var badge = SharedBadge(unread: [], events: 0, notifyAllRooms: [])
        switch scenario {
        case "already-listed":
            list.rows = [.init(id: sender, kind: "chat", name: "Private fixture name", unread: 1, mentions: 0, last: 1)]
        case "account-mismatch": list.account = "other@example.com"
        case "not-counted": badge.unread = [sender]
        default: break
        }
        if scenario != "list-unavailable" { try list.write(root: root) }
        if scenario != "badge-unavailable" {
            try JSONEncoder().encode(badge).write(to: root.appendingPathComponent("NotificationBadge.json"))
        }
        let store: NotificationDiagnostic?
        if scenario == "diagnostic-unavailable" {
            // Refuse SQLite's open while leaving widget/badge files usable.
            try FileManager.default.createDirectory(at: root.appendingPathComponent("NotificationDiagnostic.sqlite"), withIntermediateDirectories: false)
            store = nil
        } else {
            store = try NotificationDiagnostic(root: root)
            try store!.activate()
        }
        let content = UNMutableNotificationContent()
        content.body = "Private fixture message"
        content.userInfo = ["from": sender + "/phone", "to": account, "encrypted": false]
        let service = NotificationService()
        service.loadNames = { names }
        service.readSnapshot = { nil } // Never request the real keychain.
        service.ledgerRoot = { root }
        var delivered = 0
        service.didReceive(UNNotificationRequest(identifier: "fixture-request", content: content, trigger: nil)) { result in
            precondition(result.body == content.body, "Diagnostic outcomes must not change notification delivery")
            delivered += 1
        }
        precondition(delivered == 1)
        let written = UnreadList.load(root: root)
        if scenario == "success" || scenario == "diagnostic-unavailable" {
            precondition(written?.rows.first?.id == sender && written?.total == 1,
                         "The actual extension hook must persist the counted conversation")
        } else if scenario == "list-unavailable" {
            precondition(written == nil)
        } else {
            precondition(written == list, "Skipped widget changes must leave its file unchanged")
        }
        guard let store else {
            print("diagnostic-unavailable: notification delivered and unread row persisted without diagnostics")
            return
        }
        let data = try store.export()
        let entries = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        let decisions = entries.map { $0["decision"] as! String }
        let widget: [String]
        switch scenario {
        case "success":
            #if os(iOS)
            widget = ["widgetRowSelected", "widgetWriteSucceeded", "widgetReloadRequested"]
            #else
            widget = ["widgetRowSelected", "widgetWriteSucceeded", "widgetReloadUnavailable"]
            #endif
        case "already-listed": widget = ["widgetAlreadyListed"]
        case "account-mismatch": widget = ["widgetAccountMismatch"]
        case "not-counted": widget = ["widgetNotCounted"]
        case "badge-unavailable": widget = ["widgetBadgeUnavailable"]
        case "list-unavailable": widget = ["widgetListUnavailable"]
        default: preconditionFailure("Unknown fixture")
        }
        // The unchanged transport-only delivery also records its terminal fallback decision.
        precondition(decisions == ["received"] + widget + ["notEncrypted", "noEngineResult"], "Unexpected export: \(decisions)")
        precondition(Set(entries.map { $0["correlation"] as! String }).count == 1,
                     "Push and widget events must share the same random processing marker")
        let times = entries.map { $0["time"] as! Double }
        precondition(zip(times, times.dropFirst()).allSatisfy { $0 <= $1 })
        for entry in entries {
            var fields: Set<String> = ["version", "time", "correlation", "decision"]
            if entry["decision"] as? String == "noEngineResult" {
                fields.insert("durationMs")
                precondition((entry["durationMs"] as? Int ?? -1) >= 0)
            }
            precondition(Set(entry.keys) == fields, "Export only the existing content-free schema")
        }
        let text = String(data: data, encoding: .utf8)!
        for privateValue in [account, sender, "other@example.com", "Private fixture name", content.body, "fixture-request"] {
            precondition(!text.contains(privateValue), "No account, conversation, message or request identity may enter diagnostics")
        }
        if scenario == "success" { print(text) }
        print("\(scenario): actual extension mutation and content-free diagnostic export passed")
    }
}
