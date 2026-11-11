import Foundation
import UserNotifications

/// Run the real extension hook, unread-file mutation and SQLite export in disposable storage.
/// No app identity or shared keychain entitlement is installed in this executable.
@main struct WidgetDiagnosticChecks {
    static let account = "fixture@example.com"
    static let sender = "sender@example.com"

    static func appTrace(_ scenario: String, root: URL, list: UnreadList, store: NotificationDiagnostic) throws {
        let center = NotificationCenter(), queue = DispatchQueue(label: "widget-trace-fixture")
        let reads = PreviewTrace.AppReads()
        var owner: String? = account
        let observer = PreviewTrace.observeWidgetPublications(root: { root }, account: { owner }, queue: queue,
            afterPublication: { root, account, snapshot in reads.published(root: root, account: account, snapshotAt: snapshot) }, center: center)
        defer { center.removeObserver(observer) }
        let record = PreviewTrace.batchRecorder(root: root, correlation: UUID())
        func decisions() throws -> [String] {
            let entries = try JSONSerialization.jsonObject(with: store.export()) as! [[String: Any]]
            return entries.map { $0["decision"] as! String }
        }
        func publish(_ decision: WidgetPublication.Decision) {
            let time = Date().timeIntervalSince1970
            WidgetPublication.post(account: account, events: [.init(decision: decision, time: time),
                .init(decision: .reloadRequested, time: time)], snapshotAt: UnreadList.load(root: root)!.updated / 1000, center: center)
            queue.sync {} // Await this publication's actual diagnostic work, not an arbitrary delay.
        }
        let expected: [String]
        if scenario == "app-read-current" || scenario == "app-read-queued" {
            let oldSnapshot = Date().timeIntervalSince1970 - 1
            queue.sync { record(reads.observed(account: account, target: sender, time: Date().timeIntervalSince1970)) }
            if scenario == "app-read-queued" {
                WidgetPublication.post(account: account, events: [], snapshotAt: oldSnapshot, center: center)
                queue.sync {}
                let beforeCurrent = try decisions()
                precondition(beforeCurrent == ["widgetAppReadObserved"], "An older queued snapshot cannot classify a newer read")
                var cleared = list
                cleared.rows = []; cleared.total = 0
                try cleared.write(root: root)
            }
            WidgetPublication.post(account: account, events: [], snapshotAt: Date().timeIntervalSince1970, center: center)
            queue.sync {}
            expected = ["widgetAppReadObserved", "widgetAppReadNotListed"]
        } else if scenario == "app-read-clear" || scenario == "app-read-still-listed" {
            queue.sync { record(reads.observed(account: account, target: sender, time: Date().timeIntervalSince1970)) }
            let beforePublication = try decisions()
            precondition(beforePublication == ["widgetAppReadObserved"], "Do not classify the old file during debounce")
            var prefix = ["widgetAppReadObserved"]
            if scenario == "app-read-still-listed" {
                var retainedSnapshot = list
                retainedSnapshot.updated = Date().timeIntervalSince1970 * 1000
                try retainedSnapshot.write(root: root)
                publish(.written) // Negative control: a publication really did retain the read target.
                prefix += ["widgetAppListWritten", "widgetAppReloadRequested", "widgetAppReadStillListed"]
                let retained = try decisions()
                precondition(retained == prefix)
            }
            var cleared = list
            cleared.rows = []; cleared.total = 0; cleared.updated = Date().timeIntervalSince1970 * 1000
            try cleared.write(root: root)
            publish(.cleared)
            expected = prefix + ["widgetAppListCleared", "widgetAppReloadRequested", "widgetAppReadNotListed"]
        } else {
            let time = Date().timeIntervalSince1970
            WidgetPublication.post(account: "other@example.com", events: [.init(decision: .cleared, time: time)], center: center)
            center.post(name: Notification.Name("net.processone.fluux.widget-publication"), object: nil,
                        userInfo: ["account": account, "events": [["decision": "Private arbitrary error", "time": time]]])
            queue.sync { owner = nil; reads.clear() }
            WidgetPublication.post(account: account, events: [.init(decision: .cleared, time: time)], center: center)
            queue.sync {}
            queue.sync { owner = account }
            do {
                queue.suspend()
                defer { queue.resume() }
                WidgetPublication.post(account: account, events: [.init(decision: .written, time: time),
                    .init(decision: .reloadRequested, time: time)], center: center)
                let held = try decisions()
                precondition(held.isEmpty, "Posting must return without waiting for the background diagnostic queue")
            }
            queue.sync {}
            expected = ["widgetAppListWritten", "widgetAppReloadRequested"]
        }
        let data = try store.export()
        let entries = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        precondition(entries.map { $0["decision"] as! String } == expected)
        precondition(entries.allSatisfy { Set($0.keys) == ["version", "time", "correlation", "decision"] })
        let text = String(data: data, encoding: .utf8)!
        for value in [account, sender, "other@example.com", "Private fixture name", "Private arbitrary error"] {
            precondition(!text.contains(value), "The app trace must retain no identity or arbitrary text")
        }
        if scenario == "app-read-clear" || scenario == "app-read-still-listed" || scenario == "app-read-current" || scenario == "app-read-queued" { print(text) }
        print("\(scenario): actual file read/clear, in-process publication and bounded export passed")
    }

    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let scenario = CommandLine.arguments[1]
        var names = SharedNames(contacts: [sender: "Private fixture name"], account: account)
        var list = UnreadList(account: account, total: 0, rows: [], updated: 1)
        var badge = SharedBadge(unread: [], events: 0, notifyAllRooms: [])
        switch scenario {
        case "already-listed", "app-read-clear", "app-read-still-listed", "app-read-queued":
            list.rows = [.init(id: sender, kind: "chat", name: "Private fixture name", unread: 1, mentions: 0, last: 1)]
            list.total = 1
        case "count-mismatch", "push-reconciles-read-row", "already-counted-stale-row":
            list.rows = [.init(id: "stale@example.com", kind: "chat", name: "Private stale name", unread: 1, mentions: 0, last: 1)]
            if scenario == "count-mismatch" {
                list.rows.append(.init(id: "stale2@example.com", kind: "chat", name: "Private stale name", unread: 1, mentions: 0, last: 1))
            }
            list.total = 1
        case "already-counted-current":
            list.rows = [.init(id: sender, kind: "chat", name: "Private fixture name", unread: 7, mentions: 0, last: 1)]
            list.total = 1
        case "account-mismatch", "both-owners-differ", "already-counted-list-owner-mismatch": list.account = "other@example.com"
        case "not-counted": names.rooms[sender] = "Private muted room"
        default: break
        }
        if scenario.hasPrefix("already-counted-") { badge.unread = [sender] }
        if scenario != "list-unavailable" { try list.write(root: root) }
        if scenario != "badge-unavailable" {
            var state = try JSONSerialization.jsonObject(with: JSONEncoder().encode(badge)) as! [String: Any]
            if scenario != "badge-legacy" { state["account"] = ["badge-other-account", "both-owners-differ"].contains(scenario) ? "other@example.com" : account }
            try JSONSerialization.data(withJSONObject: state).write(to: root.appendingPathComponent("NotificationBadge.json"))
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
        if scenario.hasPrefix("app-") {
            try appTrace(scenario, root: root, list: list, store: store!)
            return
        }
        let badgeBefore = try? Data(contentsOf: root.appendingPathComponent("NotificationBadge.json"))
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
        if ["success", "already-listed", "diagnostic-unavailable", "count-mismatch", "push-reconciles-read-row",
            "already-counted-missing-row", "already-counted-stale-row"].contains(scenario) {
            precondition(written?.rows.first?.id == sender && written?.total == 1,
                         "The actual extension hook must persist the counted conversation")
        } else if scenario == "list-unavailable" {
            precondition(written == nil)
        } else {
            precondition(written == list, "Skipped widget changes must leave its file unchanged")
        }
        if ["badge-other-account", "both-owners-differ"].contains(scenario) || scenario.hasPrefix("already-counted-") {
            precondition((try? Data(contentsOf: root.appendingPathComponent("NotificationBadge.json"))) == badgeBefore,
                         "Another account's badge and already-counted pushes must not mutate badge membership")
        }
        if scenario == "badge-legacy" {
            // Captain's decision: a badge written by an older build, with no owner, still raises the app icon
            // count, but it never adds or removes widget rows (the list was checked unchanged above).
            let after = try JSONDecoder().decode(SharedBadge.self, from: Data(contentsOf: root.appendingPathComponent("NotificationBadge.json")))
            precondition(after.account == nil && after.unread.contains(sender), "An unowned badge may still count the push for the icon")
            precondition(delivered == 1)
        }
        if scenario == "already-counted-current" {
            precondition(written?.rows.first?.unread == 7, "Keep the app's precise unread count")
        }
        if scenario == "push-reconciles-read-row" || scenario == "count-mismatch" || scenario == "already-counted-stale-row" {
            FileHandle.standardOutput.write(Data("actual shared widget state: ".utf8) + (try JSONEncoder().encode(written)) + Data("\n".utf8))
            guard written?.rows.map(\.id) == [sender] && written?.total == 1 else {
                FileHandle.standardError.write(Data("Prune the read row from the counted unread set; never raise the total to hide it\n".utf8))
                try? FileManager.default.removeItem(at: root)
                exit(1)
            }
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
        case "success", "push-reconciles-read-row", "already-counted-missing-row", "already-counted-stale-row":
            #if os(iOS)
            widget = ["widgetRowSelected", "widgetWriteSucceeded", "widgetReloadRequested"]
            #else
            widget = ["widgetRowSelected", "widgetWriteSucceeded", "widgetReloadUnavailable"]
            #endif
        case "count-mismatch":
            widget = ["widgetCountMismatch", "widgetRowSelected", "widgetWriteSucceeded", "widgetReloadUnavailable"]
        case "already-listed": widget = ["widgetAlreadyListed", "widgetWriteSucceeded", "widgetReloadUnavailable"]
        case "already-counted-current": widget = ["widgetAlreadyListed"]
        case "account-mismatch", "already-counted-list-owner-mismatch": widget = ["widgetAccountMismatch", "widgetListOwnerMismatch"]
        case "badge-other-account", "both-owners-differ": widget = ["widgetAccountMismatch", "widgetBadgeOwnerMismatch"]
        case "badge-legacy": widget = ["widgetAccountMismatch", "widgetBadgeOwnerMissing"]
        case "not-counted": widget = ["widgetNotCounted"]
        case "badge-unavailable": widget = ["widgetBadgeUnavailable"]
        case "list-unavailable": widget = ["widgetListUnavailable"]
        default: preconditionFailure("Unknown fixture")
        }
        precondition(decisions.first == "received", "The push receipt must precede its widget decisions")
        precondition(decisions.filter { $0.hasPrefix("widget") } == widget, "Unexpected widget export: \(decisions)")
        precondition(Set(entries.map { $0["correlation"] as! String }).count == 1,
                     "Push and widget events must share the same random processing marker")
        let times = entries.map { $0["time"] as! Double }
        precondition(zip(times, times.dropFirst()).allSatisfy { $0 <= $1 })
        for entry in entries {
            let required: Set<String> = ["version", "time", "correlation", "decision"]
            let allowed = required.union(["durationMs"])
            precondition(required.isSubset(of: Set(entry.keys)) && Set(entry.keys).isSubset(of: allowed),
                         "Export only the existing content-free schema")
        }
        let text = String(data: data, encoding: .utf8)!
        for privateValue in [account, sender, "other@example.com", "Private fixture name", "Private muted room", content.body, "fixture-request"] {
            precondition(!text.contains(privateValue), "No account, conversation, message or request identity may enter diagnostics")
        }
        if scenario == "success" { print(text) }
        print("\(scenario): actual extension mutation and content-free diagnostic export passed")
        if scenario == "count-mismatch" {
            print("The trace flags the old inconsistent input; the persisted snapshot is reconciled")
        }
    }
}
