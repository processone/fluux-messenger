import Foundation
import UserNotifications

// FLM-95: own the exact local iOS payload contract, using the locked plugin's
// content producer and action serializer, not an Android-shaped JS mock.
@main struct NotificationTapPayloadTests {
    static func main() throws {
        let fixtures = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
        for fixture in fixtures {
            let options = try JSONDecoder().decode(Notification.self, from: JSONSerialization.data(withJSONObject: fixture["options"]!))
            let content = try makeNotificationContent(options)
            precondition(NSDictionary(dictionary: content.userInfo).isEqual(to: fixture["userInfo"] as! [AnyHashable: Any]))
            let request = UNNotificationRequest(identifier: String(options.id), content: content, trigger: nil)
            let handler = NotificationHandler()
            handler.saveNotification(request.identifier, options)
            let active = try JSONSerialization.jsonObject(with: JSONEncoder().encode(handler.toActiveNotification(request))) as! [String: Any]
            let action = fixture["actionPerformed"] as! [String: Any]
            precondition(NSDictionary(dictionary: active).isEqual(to: action["notification"] as! [AnyHashable: Any]))
            print("iOS plugin content: \(content.userInfo); action notification: \(active)")
        }
        print("iOS local notification payload contract passed")
    }
}
