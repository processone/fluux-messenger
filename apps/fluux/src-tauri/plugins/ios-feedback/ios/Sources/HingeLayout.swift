import CoreGraphics

/// The posture and hinge line Fluux reports to the page on a foldable iPhone, such as the iPhone Duo.
///
/// UIKit reports whether the hinge is half open (`UIHingeInteraction`) and where the screen divides
/// (`UIView.reservedRegions(kind: .division)`): a band around the fold, whose margins are the room
/// buttons keep clear. On the Duo's 951-point inner screen the band runs from 455.5 to 495.5 points,
/// a fold at 475.5 with 20-point margins on each side. The closed cover screen has no band.
struct HingeLayout: Equatable {
    enum Posture: String { case flat, folded }
    enum Line: Equatable {
        /// A fold running top to bottom, this many points from the web view's left edge.
        case vertical(x: CGFloat)
        /// A fold running left to right, this many points from the web view's top edge.
        case horizontal(y: CGFloat)
    }

    /// A division region as UIKit reports it: its frame in the web view's coordinates, margins
    /// included, and those margins.
    struct Division: Equatable {
        var frame: CGRect
        var top: CGFloat = 0
        var left: CGFloat = 0
        var bottom: CGFloat = 0
        var right: CGFloat = 0
    }

    let posture: Posture
    /// Absent when flat, or when no division crosses the web view.
    let line: Line?
    /// How far buttons keep from the line on each side, in points.
    let margin: CGFloat

    /// - Parameters:
    ///   - folded: whether the hinge is partially open. Fully open and closed both lay out flat.
    ///   - divisions: the web view's division regions, active or not.
    ///   - bounds: the web view's bounds.
    init(folded: Bool, divisions: [Division], bounds: CGRect) {
        posture = folded ? .folded : .flat
        let crossing = folded ? divisions.lazy.compactMap { Self.line(of: $0, in: bounds) }.first : nil
        line = crossing?.line
        margin = crossing?.margin ?? 0
    }

    /// The fold is the middle of the band without its margins; a band taller than wide is a fold
    /// running top to bottom.
    private static func line(of division: Division, in bounds: CGRect) -> (line: Line, margin: CGFloat)? {
        let frame = division.frame
        if frame.height > frame.width {
            let fold = (frame.minX + division.left + frame.maxX - division.right) / 2
            let x = fold - bounds.minX
            guard x > 0, x < bounds.width else { return nil }
            return (.vertical(x: x), max(fold - frame.minX, frame.maxX - fold))
        }
        let fold = (frame.minY + division.top + frame.maxY - division.bottom) / 2
        let y = fold - bounds.minY
        guard y > 0, y < bounds.height else { return nil }
        return (.horizontal(y: y), max(fold - frame.minY, frame.maxY - fold))
    }

    /// One log line naming what the page receives.
    var summary: String {
        switch line {
        case .vertical(let x): return "posture=\(posture.rawValue) hinge-x=\(Double(x)) margin=\(Double(margin))"
        case .horizontal(let y): return "posture=\(posture.rawValue) hinge-y=\(Double(y)) margin=\(Double(margin))"
        case nil: return "posture=\(posture.rawValue) no-line"
        }
    }

    /// The script that sets the CSS variables on `<html>`, which `useHingePosture` reads:
    /// `--fluux-device-posture` (`flat` or `folded`), then with a line `--fluux-hinge-x` or
    /// `--fluux-hinge-y` and `--fluux-hinge-margin`, in CSS pixels. With no hinge at all (`nil`),
    /// the script removes them.
    static func script(for layout: HingeLayout?) -> String {
        var set: [(String, String)] = []
        if let layout {
            set.append(("--fluux-device-posture", layout.posture.rawValue))
            switch layout.line {
            case .vertical(let x): set.append(("--fluux-hinge-x", "\(Double(x))px"))
            case .horizontal(let y): set.append(("--fluux-hinge-y", "\(Double(y))px"))
            case nil: break
            }
            if layout.line != nil { set.append(("--fluux-hinge-margin", "\(Double(layout.margin))px")) }
        }
        let statements = ["--fluux-device-posture", "--fluux-hinge-x", "--fluux-hinge-y", "--fluux-hinge-margin"].map { name in
            if let value = set.first(where: { $0.0 == name })?.1 { return "s.setProperty('\(name)','\(value)');" }
            return "s.removeProperty('\(name)');"
        }
        return "(function(){var s=document.documentElement.style;\(statements.joined())})();"
    }
}
