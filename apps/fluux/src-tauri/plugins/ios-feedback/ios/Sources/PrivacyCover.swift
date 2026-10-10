import UIKit

/// Covers deactivating scene windows, or all app windows on application deactivation, before UIKit snapshots them.
final class PrivacyCover {
    private var covers: [UIWindow: UIView] = [:]
    private var observers: [NSObjectProtocol] = []

    init() {
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
            cover(windows: UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .filter { $0.activationState != .foregroundActive }.flatMap { $0.windows })
        }
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    func cover(windows: [UIWindow]? = nil) {
        let windows = windows ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
        for window in windows where !window.isHidden {
            let view = covers[window] ?? UIView(frame: window.bounds)
            view.backgroundColor = .systemBackground
            view.isOpaque = true
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.accessibilityElementsHidden = true
            view.frame = window.bounds
            window.addSubview(view)
            window.bringSubviewToFront(view)
            covers[window] = view
        }
    }
    func uncoverActive(windows: [UIWindow]? = nil) {
        guard UIApplication.shared.applicationState == .active else { return }
        for (window, cover) in covers where (windows?.contains(window) != false) && (window.windowScene?.activationState == .foregroundActive || window.windowScene == nil) {
            cover.removeFromSuperview()
            covers.removeValue(forKey: window)
        }
    }
}
