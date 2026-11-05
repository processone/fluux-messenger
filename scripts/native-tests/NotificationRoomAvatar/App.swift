import UIKit
import UserNotifications
import CryptoKit
import Intents

// Regression: room notifications must show the room image and keep room-before-nickname text.
// Names and body follow the recorded room-first notification case; identities are disposable.
enum Fixture {
    static let room = "xsf@muc.xmpp.org"
    static let account = "me@example.com"
    static let body = "> finally, XSF funding!"
    static func record(_ message: String) {
        let url = NotificationMirror.root!.appendingPathComponent("diagnostics.txt")
        let existing = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (existing + message + "\n").write(to: url, atomically: true, encoding: .utf8)
    }
    static func prepare() throws -> SharedNames {
        let root = NotificationMirror.root!
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let data = try Data(contentsOf: Bundle.main.url(forResource: "room-avatar", withExtension: "png")!)
        let senderData = try Data(contentsOf: Bundle.main.url(forResource: "Icon60@2x", withExtension: "png")!)
        func hash(_ bytes: Data) -> String {
            Insecure.SHA1.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        }
        var names = SharedNames(contacts: ["seve@example.com": "Seve"], rooms: [room: "XSF"],
                                avatars: [room: hash(data), "seve@example.com": hash(senderData)], account: account)
        names.roomParticipants[room] = SharedRoomParticipants(ownNick: "Me", nicks: ["Seve", "Me", "Other"])
        try NotificationMirror.writeNames(names, root: root)
        for bytes in [data, senderData] {
            let avatarData = try JSONSerialization.data(withJSONObject: ["account": account, "hash": hash(bytes), "data": bytes.base64EncodedString()])
            let avatar = try JSONDecoder().decode(NotificationAvatar.self, from: avatarData)
            guard try NotificationMirror.writeAvatar(avatar, root: root) else { throw CocoaError(.fileWriteUnknown) }
        }
        return SharedNames.load()
    }
    static func original() -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Fluux Messenger"
        content.body = body
        content.sound = .default
        content.threadIdentifier = room
        content.userInfo = ["from": room, "muc_nick": "Seve", "to": account, "encrypted": false]
        return content
    }
}
@main final class App: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = Controller()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
    // Same foreground delivery options as the project's native notification harness.
    // This displays the presentation output; it is not an APNs extension journey.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        let content = notification.request.content
        Fixture.record("willPresent title=\(content.title), subtitle=\(content.subtitle), attachments=\(content.attachments.count)")
        for attachment in content.attachments {
            let accessing = attachment.url.startAccessingSecurityScopedResource()
            let bytes = (try? Data(contentsOf: attachment.url))?.count ?? 0
            Fixture.record("delivered image type=\(attachment.type), bytes=\(bytes)")
            if accessing { attachment.url.stopAccessingSecurityScopedResource() }
        }
        completion([.banner, .list, .sound])
    }
}
final class Controller: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let label = UILabel(); label.numberOfLines = 0; label.accessibilityIdentifier = "fixture-status"
        label.text = "Enable notification permission before posting"
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        let permission = UIButton(type: .system); permission.setTitle("Enable notifications", for: .normal)
        permission.addAction(UIAction { _ in
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { allowed, _ in
                DispatchQueue.main.async {
                    label.text = allowed ? "Ready to post room alert" : "Notification permission denied"
                    permission.isHidden = allowed
                }
            }
        }, for: .touchUpInside)
        let button = UIButton(type: .system); button.setTitle("Post room alert", for: .normal)
        button.addAction(UIAction { _ in
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { allowed, error in
                guard allowed else { return }
                do {
                    let names = try Fixture.prepare()
                    let content = NotificationPresentation.content(for: Fixture.original(), names: names)
                    Fixture.record("producer attachments=\(content.attachments.count)")
                    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "room-avatar-repro", content: content, trigger: nil)) { error in
                        Fixture.record("add accepted=\(error == nil); error=\(String(describing: error))")
                        DispatchQueue.main.async { label.text = error == nil ? "Posted room alert" : "Notification failed" }
                    }
                } catch { print("Fixture failed: \(error)") }
            }
        }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [label, permission, button]); stack.axis = .vertical; stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
                                     stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
                                     stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    }
}
