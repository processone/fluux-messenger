import UIKit
import ImageIO

/// Isolated receiver: no account, network, or message sending.
@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBackground
        let label = UILabel(frame: CGRect(x: 20, y: 150, width: 350, height: 450))
        label.numberOfLines = 0
        label.accessibilityIdentifier = "import-result"
        do {
            let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.net.processone.fluux.share")!
            let inbox = group.appendingPathComponent("ShareInbox")
            let entries = try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)
                .filter { !$0.lastPathComponent.hasPrefix(".") }
            let results = try entries.map { directory -> String in
                let entry = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("entry.json"))) as! [String: Any]
                let data = try Data(contentsOf: directory.appendingPathComponent("data"))
                let image = UIImage(data: data)
                let source = CGImageSourceCreateWithData(data as CFData, nil)
                let type = source.flatMap { CGImageSourceGetType($0) } as String? ?? "unknown"
                return "\(entry["name"]!) | \(entry["mime"]!) | \(type) | decodable=\(image != nil)"
            }
            label.text = results.joined(separator: "\n")
            // Each journey starts with an empty inbox.
            for entry in entries { try FileManager.default.removeItem(at: entry) }
        } catch { label.text = "Import error: \(error)" }
        print("SHARE_IMPORT_RESULT \(label.text ?? "")")
        controller.view.addSubview(label)
        window?.rootViewController = controller
        window?.makeKeyAndVisible()
        return true
    }
}
