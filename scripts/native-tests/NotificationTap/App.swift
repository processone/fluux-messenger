import UIKit
import UserNotifications
import Tauri

// FLM-95: run the real notification plugin and production delegate. Replace
// only the Tauri bridge; the web hook consumes the same shared userInfo fixture.
private class PushPlugin {
    static let shared: PushPlugin? = PushPlugin()
    func restoreBadge() {}
    func didTap(userInfo: [AnyHashable: Any]) {
        precondition(Thread.isMainThread)
        precondition(fixtures.contains { NSDictionary(dictionary: userInfo).isEqual(to: $0["userInfo"] as! [AnyHashable: Any]) })
        showPayload("Retained tap", userInfo)
    }
}
private let fixtures = try! JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.main.url(forResource: "payloads", withExtension: "json")!)) as! [[String: Any]]
private var status: UILabel!
private func showPayload(_ source: String, _ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    let json = String(data: data, encoding: .utf8)!
    print("\(source): \(json)")
    DispatchQueue.main.async { status.text = "\(source): \(json)" }
}
@main final class App: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var plugin: NotificationPlugin!
    private var delegate: RemoteNotificationDelegate!
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        plugin = NotificationPlugin()
        delegate = RemoteNotificationDelegate(wrapping: UNUserNotificationCenter.current().delegate)
        UNUserNotificationCenter.current().delegate = delegate
        Plugin.event = { event, data in showPayload(event, try! JSONSerialization.jsonObject(with: data)) }
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = Controller(plugin: plugin)
        window.makeKeyAndVisible(); self.window = window
        return true
    }
}
private final class Controller: UIViewController {
    let plugin: NotificationPlugin
    init(plugin: NotificationPlugin) { self.plugin = plugin; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError() }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        let title = UILabel(); title.text = "Fluux iOS notification tap fixture"
        status = UILabel(); status.numberOfLines = 0; status.text = "Ready"; status.accessibilityIdentifier = "payload"
        let stack = UIStackView(arrangedSubviews: [title]); stack.axis = .vertical; stack.spacing = 24; stack.translatesAutoresizingMaskIntoConstraints = false
        for fixture in fixtures {
            let options = fixture["options"] as! [String: Any]
            let kind = (options["extra"] as! [String: Any])["navType"] as! String
            let button = UIButton(type: .system); button.setTitle("Post \(kind)", for: .normal)
            button.addAction(UIAction { _ in
                status.text = "Waiting for \(kind) tap"
                try! self.plugin.show(Invoke(data: try! JSONSerialization.data(withJSONObject: options)))
            }, for: .touchUpInside)
            stack.addArrangedSubview(button)
        }
        stack.addArrangedSubview(status); view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _,_ in }
    }
}
