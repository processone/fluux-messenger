import UIKit

// FLM-31: isolated native runtime for the production export helper; no account or signing.
@main final class App: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = DiagnosticController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
final class DiagnosticController: UIViewController {
    let status = UILabel()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let button = UIButton(type: .system)
        button.setTitle("Exporter le diagnostic", for: .normal)
        button.addTarget(self, action: #selector(export), for: .touchUpInside)
        let label = UILabel(); label.text = "Fluux · Test isolé du partage natif"
        status.text = "Prêt"; status.accessibilityIdentifier = "status"
        let stack = UIStackView(arrangedSubviews: [label, button, status])
        stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: view.centerXAnchor), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        NotificationDiagnosticShare.clear()
    }
    @objc func export() {
        do {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("diagnostic-fixture")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let store = try NotificationDiagnostic(root: root)
            try store.reset(active: true)
            let record = PreviewTrace.recorder(root: root)
            record(.received, nil); record(.nothingNew, 712)
            let data = try store.export()
            let entries = try JSONDecoder().decode([NotificationDiagnostic.Entry].self, from: data)
            precondition(entries.count == 2 && entries[0].correlation == entries[1].correlation)
            precondition(entries[0].version.contains(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as! String))
            try NotificationDiagnosticShare.present(data: data, from: self) {
                self.status.text = FileManager.default.fileExists(atPath: NotificationDiagnosticShare.directory.path) ? "Fichier restant" : "Copie supprimée"
            }
        } catch { status.text = "Échec" }
    }
}
