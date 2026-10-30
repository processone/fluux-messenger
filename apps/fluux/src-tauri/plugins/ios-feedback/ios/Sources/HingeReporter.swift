import UIKit
import WebKit
import os

// UIHingeInteraction and reserved regions are public from the iOS 27.1 SDK (UIKit 9127.0.85). Older
// SDKs, such as the one the project's CI builds with, leave the reporter out; the page then lays out
// flat, as before.
#if canImport(UIKit, _version: 9127.0.85)
/// Watches the hinge of a foldable iPhone, such as the iPhone Duo, and reports it to the page as CSS
/// variables (see `HingeLayout`): its posture from `UIHingeInteraction`, and where the screen divides
/// from the web view's division regions. Only public UIKit and WebKit APIs are used.
@available(iOS 27.1, *)
final class HingeReporter {
    private static let log = Logger(subsystem: "net.processone.fluux", category: "hinge")
    private weak var webView: WKWebView?
    private var interaction: UIHingeInteraction?
    /// nil until UIKit reports a hinge, so a device without one never touches the page.
    private var folded: Bool?
    private var observedScene: UIWindowScene?
    private var geometryObservation: NSKeyValueObservation?
    private var loadingObservation: NSKeyValueObservation?
    /// What the current document already has; a new document starts with nothing set.
    private var applied = HingeLayout.script(for: nil)
    /// UIKit reports no change to the division regions. Unfolding from the cover screen, the hinge
    /// reports half open before the inner screen has its band, so while half open without a line,
    /// look again every quarter second, up to ten seconds after the last change.
    private static let recheckDelay = 0.25
    private static let rechecks = 40
    private var rechecksLeft = 0
    private var recheck: DispatchWorkItem?

    init(webView: WKWebView) {
        self.webView = webView
        let interaction = UIHingeInteraction { [weak self] _, update in
            self?.hingeChanged(update.hinge)
        }
        webView.addInteraction(interaction)
        self.interaction = interaction
        loadingObservation = webView.observe(\.isLoading) { [weak self] webView, _ in
            guard !webView.isLoading else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.applied = HingeLayout.script(for: nil)
                self.changed()
            }
        }
    }

    private func hingeChanged(_ hinge: UIHinge?) {
        folded = hinge.map { $0.status == .partiallyOpen }
        // UIKit also calls this when the web view moves to another window, so follow its scene.
        observe(webView?.window?.windowScene)
        changed()
    }

    /// The division moves between axes when the interface turns, without a hinge update.
    private func observe(_ scene: UIWindowScene?) {
        guard scene !== observedScene else { return }
        observedScene = scene
        geometryObservation = scene?.observe(\.effectiveGeometry) { [weak self] _, _ in
            DispatchQueue.main.async { self?.changed() }
        }
    }

    private func changed() {
        rechecksLeft = Self.rechecks
        update()
    }

    private func update() {
        recheck?.cancel()
        recheck = nil
        guard let webView else { return }
        var layout: HingeLayout?
        if let folded {
            // Inactive regions too: UIKit marks the band active about 0.75 s after the hinge reports
            // half open, and the hinge's state already says whether to divide. The closed cover
            // screen reports no band, so it gets no line.
            let divisions = folded ? webView.reservedRegions(kind: .division, options: .includeInactive).map {
                HingeLayout.Division(frame: $0.frame, top: $0.margins.top, left: $0.margins.left,
                                     bottom: $0.margins.bottom, right: $0.margins.right)
            } : []
            layout = HingeLayout(folded: folded, divisions: divisions, bounds: webView.bounds)
        }
        if let layout, layout.posture == .folded, layout.line == nil, rechecksLeft > 0 {
            rechecksLeft -= 1
            let item = DispatchWorkItem { [weak self] in self?.update() }
            recheck = item
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.recheckDelay, execute: item)
        }
        let script = HingeLayout.script(for: layout)
        guard script != applied else { return }
        applied = script
        Self.log.info("\(layout?.summary ?? "no hinge", privacy: .public)")
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
}
#endif
