import Foundation
import UserNotifications

@main struct CheckNotifications {
    static func check(from: Any? = nil, existing: String = "", expected: String) {
        let content = UNMutableNotificationContent()
        content.threadIdentifier = existing
        if let from = from { content.userInfo = ["from": from] }
        let request = UNNotificationRequest(identifier: "fixture", content: content, trigger: nil)
        var delivered = false
        NotificationService().didReceive(request) { result in
            precondition(result.threadIdentifier == expected,
                         "Expected thread '\(expected)', got '\(result.threadIdentifier)'")
            delivered = true
        }
        precondition(delivered, "The extension must deliver the notification")
        precondition(request.content.threadIdentifier == existing, "The request must remain unchanged")
    }

    static func main() {
        switch CommandLine.arguments[1] {
        case "direct":
            check(from: "alice@example.com/phone", expected: "alice@example.com")
            check(from: "alice@example.com", expected: "alice@example.com")
        case "room":
            check(from: "team@conference.example.com/alice", expected: "team@conference.example.com")
            check(from: "team@conference.example.com/bob", expected: "team@conference.example.com")
            check(from: "team@conference.example.com", expected: "team@conference.example.com")
        case "existing":
            check(from: "alice@example.com/phone", existing: "server-thread", expected: "server-thread")
            check(from: "team@conference.example.com/alice", existing: "room-thread", expected: "room-thread")
            check(existing: "server-thread", expected: "server-thread")
        case "missing":
            check(expected: "")
            for invalid: Any in [42, "", "example.com", "/alice@example.com", "@example.com", "alice@", " "] {
                check(from: invalid, expected: "")
            }
        default:
            preconditionFailure("Unknown fixture")
        }
        print("Notification grouping passed")
    }
}
