import UIKit
import UniformTypeIdentifiers

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = Sender()
        window?.makeKeyAndVisible()
        return true
    }
}
final class Sender: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        for (index, name) in ["Share UIImage", "Share PNG"].enumerated() {
            let button = UIButton(type: .system)
            button.setTitle(name, for: .normal)
            button.tag = index
            button.frame = CGRect(x: 70, y: 200 + index * 100, width: 250, height: 80)
            button.addTarget(self, action: #selector(share(_:)), for: .touchUpInside)
            view.addSubview(button)
        }
    }
    @objc func share(_ button: UIButton) {
        let url = Bundle.main.url(forResource: "fluux-logo", withExtension: "png")!
        let share: UIActivityViewController
        if button.tag == 0 {
            // Match the UIImage activity item used to reproduce the archived-object bug.
            share = UIActivityViewController(activityItems: [UIImage(contentsOfFile: url.path)!], applicationActivities: nil)
        } else {
            let provider = NSItemProvider()
            provider.suggestedName = url.lastPathComponent
            let data = try! Data(contentsOf: url)
            provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { completion in
                completion(data, nil)
                return nil
            }
            share = UIActivityViewController(activityItemsConfiguration: UIActivityItemsConfiguration(itemProviders: [provider]))
        }
        share.popoverPresentationController?.sourceView = view
        present(share, animated: true)
    }
}
