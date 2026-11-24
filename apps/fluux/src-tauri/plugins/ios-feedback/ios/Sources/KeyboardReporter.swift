import UIKit
import WebKit

final class KeyboardReporter {
    private weak var webView: WKWebView?
    private var frame: CGRect?
    private var applied: Bool?
    private var observers: [NSObjectProtocol] = []
    private var loadingObservation: NSKeyValueObservation?

    init(webView: WKWebView) {
        self.webView = webView
        observers.append(NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let self else { return }
            self.frame = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
            self.update()
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.frame = nil
            self?.update()
        })
        loadingObservation = webView.observe(\.isLoading) { [weak self] webView, _ in
            guard !webView.isLoading else { return }
            // A new document needs the current native state even if the keyboard never moved.
            DispatchQueue.main.async { self?.update(force: true) }
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    private func update(force: Bool = false) {
        guard let webView else { return }
        var docked = false
        if let window = webView.window, let frame {
            let keyboard = window.convert(frame, from: window.screen.coordinateSpace)
            let bounds = window.bounds
            let overlap = keyboard.intersection(bounds)
            // WKWebView can pan by exactly the keyboard height, leaving its visual bottom unchanged.
            // A floating keyboard must not remove space for the still-uncovered home indicator.
            docked = !overlap.isNull && overlap.height > 0
                && keyboard.minX <= bounds.minX + 1 && keyboard.maxX >= bounds.maxX - 1
                && keyboard.maxY >= bounds.maxY - 1
        }
        guard force || docked != applied else { return }
        applied = docked
        webView.evaluateJavaScript("document.documentElement.dataset.keyboardDocked = '\(docked)';", completionHandler: nil)
    }
}
