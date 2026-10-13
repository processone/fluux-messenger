import UIKit

/// Covers deactivating scene windows, or all app windows on application deactivation, before UIKit snapshots them.
final class PrivacyCover {
    private var covers: [UIWindow: UIView] = [:]
    private var observers: [NSObjectProtocol] = []
    private let applicationScenes: () -> [UIWindowScene]
    private let logo: UIImage?
    /// The app draws its own light/dark theme in web content, so the system's style is only the default.
    var appearance: UIUserInterfaceStyle = .unspecified {
        didSet { covers.values.forEach { $0.overrideUserInterfaceStyle = appearance } }
    }

    init(applicationScenes: @escaping () -> [UIWindowScene] = {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    }, logo: UIImage? = PrivacyCover.appIcon()) {
        self.applicationScenes = applicationScenes
        self.logo = logo
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.cover() })
        observers.append(center.addObserver(forName: UIScene.willDeactivateNotification, object: nil, queue: .main) { [weak self] notification in
            guard let scene = notification.object as? UIWindowScene else { return }
            self?.cover(windows: scene.windows)
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.uncoverActive() })
        observers.append(center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] notification in
            guard let scene = notification.object as? UIWindowScene else { return }
            self?.uncoverActive(windows: scene.windows)
        })
        // The app switcher snapshot is taken on the way to the background, so a returning app is uncovered as soon as
        // it heads back to the foreground rather than once active, which comes after its windows are back on screen.
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.uncover() })
        observers.append(center.addObserver(forName: UIScene.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] notification in
            guard let scene = notification.object as? UIWindowScene else { return }
            self?.uncover(windows: scene.windows)
        })
        // A returning app that leaves again before becoming active gets no second willResignActive, and UIKit takes the
        // snapshot once didEnterBackground returns, so covering there keeps that snapshot covered.
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.cover() })
        observers.append(center.addObserver(forName: UIScene.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] notification in
            guard let scene = notification.object as? UIWindowScene else { return }
            self?.cover(windows: scene.windows)
        })
        observers.append(center.addObserver(forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main) { [weak self] notification in
            guard let window = notification.object as? UIWindow else { return }
            if let scene = window.windowScene {
                if scene.activationState != .foregroundActive { self?.cover(windows: [window]) }
            } else if UIApplication.shared.applicationState != .active {
                self?.cover(windows: [window])
            }
        })
        if UIApplication.shared.applicationState != .active {
            cover()
        } else {
            cover(windows: applicationScenes()
                .filter { $0.activationState != .foregroundActive }.flatMap { $0.windows })
        }
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    func cover(windows: [UIWindow]? = nil) {
        let scenes = applicationScenes()
        let windows = windows ?? scenes.flatMap { $0.windows }
        // UIKit's remote keyboard scene is outside the application's connected scenes.
        for window in windows where !window.isHidden && scenes.contains(where: { $0 === window.windowScene }) {
            let view = covers[window] ?? makeCover()
            view.frame = window.bounds
            view.overrideUserInterfaceStyle = appearance
            window.addSubview(view)
            window.bringSubviewToFront(view)
            covers[window] = view
        }
    }
    /// A thin material already blurs body text past reading while the content stays visible as colour; a thicker one is a
    /// near-opaque white in light mode. With Reduce Transparency, UIKit renders the material opaque.
    private func makeCover() -> UIView {
        let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.accessibilityElementsHidden = true
        if let logo {
            let image = UIImageView(image: logo)
            image.translatesAutoresizingMaskIntoConstraints = false
            image.layer.cornerRadius = PrivacyCover.logoSize * 0.2237
            image.layer.cornerCurve = .continuous
            image.clipsToBounds = true
            view.contentView.addSubview(image)
            NSLayoutConstraint.activate([
                image.widthAnchor.constraint(equalToConstant: PrivacyCover.logoSize),
                image.heightAnchor.constraint(equalToConstant: PrivacyCover.logoSize),
                image.centerXAnchor.constraint(equalTo: view.contentView.centerXAnchor),
                image.centerYAnchor.constraint(equalTo: view.contentView.centerYAnchor),
            ])
        }
        return view
    }

    private static let logoSize: CGFloat = 76

    /// The app icon compiled from the asset catalog, whose image names Info.plist lists.
    static func appIcon(bundle: Bundle = .main) -> UIImage? {
        let icons = bundle.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
        let primary = icons?["CFBundlePrimaryIcon"] as? [String: Any]
        let files = primary?["CFBundleIconFiles"] as? [String]
        return files?.reversed().lazy.compactMap { UIImage(named: $0, in: bundle, compatibleWith: nil) }.first
    }

    func uncoverActive(windows: [UIWindow]? = nil) {
        guard UIApplication.shared.applicationState == .active else { return }
        uncover(windows: windows) { $0.windowScene?.activationState == .foregroundActive || $0.windowScene == nil }
    }

    private func uncover(windows: [UIWindow]? = nil, where shouldUncover: (UIWindow) -> Bool = { _ in true }) {
        for (window, cover) in covers where (windows?.contains(window) != false) && shouldUncover(window) {
            cover.removeFromSuperview()
            covers.removeValue(forKey: window)
        }
    }
}
