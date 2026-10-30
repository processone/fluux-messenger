import CoreGraphics

// FLM-279 (captain's approved answers on FLM-177): on a half-open iPhone Duo, Fluux reports the
// posture and the hinge line to the page; fully open and the closed cover screen lay out flat.
// The regions are what UIKit reported on the iPhone Duo simulator (iOS 27.1) for FLM-279: on the
// 951 x 669-point inner screen, a division band 40 points wide around the fold at 475.5 points,
// with 20-point margins; on the 466 x 678-point cover screen, none.
@main struct Check {
    static func expect(_ condition: Bool, _ message: String) {
        if !condition { fatalError("FAILED: \(message)") }
    }

    static func main() {
        let landscape = CGRect(x: 0, y: 0, width: 951, height: 669)
        let portrait = CGRect(x: 0, y: 0, width: 669, height: 951)
        let cover = CGRect(x: 0, y: 0, width: 466, height: 678)
        let landscapeBand = HingeLayout.Division(frame: CGRect(x: 455.5, y: 0, width: 40, height: 669), left: 20, right: 20)
        let portraitBand = HingeLayout.Division(frame: CGRect(x: 0, y: 455.5, width: 669, height: 40), top: 20, bottom: 20)

        let halfLandscape = HingeLayout(folded: true, divisions: [landscapeBand], bounds: landscape)
        expect(halfLandscape.posture == .folded && halfLandscape.line == .vertical(x: 475.5) && halfLandscape.margin == 20,
               "half open in landscape: \(halfLandscape.summary)")
        expect(HingeLayout.script(for: halfLandscape) ==
               "(function(){var s=document.documentElement.style;s.setProperty('--fluux-device-posture','folded');s.setProperty('--fluux-hinge-x','475.5px');s.removeProperty('--fluux-hinge-y');s.setProperty('--fluux-hinge-margin','20.0px');})();",
               "landscape script")

        let halfPortrait = HingeLayout(folded: true, divisions: [portraitBand], bounds: portrait)
        expect(halfPortrait.posture == .folded && halfPortrait.line == .horizontal(y: 475.5) && halfPortrait.margin == 20,
               "half open in portrait: \(halfPortrait.summary)")
        expect(HingeLayout.script(for: halfPortrait) ==
               "(function(){var s=document.documentElement.style;s.setProperty('--fluux-device-posture','folded');s.removeProperty('--fluux-hinge-x');s.setProperty('--fluux-hinge-y','475.5px');s.setProperty('--fluux-hinge-margin','20.0px');})();",
               "portrait script")

        // The fold is the middle of the band without its margins, so uneven margins move it.
        let uneven = HingeLayout(folded: true, divisions: [HingeLayout.Division(frame: CGRect(x: 455.5, y: 0, width: 40, height: 669), left: 30, right: 10)],
                                 bounds: landscape)
        expect(uneven.line == .vertical(x: 485.5) && uneven.margin == 30, "uneven margins: \(uneven.summary)")

        // While the device closes, UIKit still reports half open on the cover screen for a moment,
        // which has no band: the page gets the posture without a line.
        let closing = HingeLayout(folded: true, divisions: [], bounds: cover)
        expect(closing.posture == .folded && closing.line == nil, "closing onto the cover screen: \(closing.summary)")

        // A web view the band does not cross gets the posture without a line.
        let narrow = HingeLayout(folded: true, divisions: [landscapeBand], bounds: CGRect(x: 0, y: 0, width: 470, height: 669))
        expect(narrow.posture == .folded && narrow.line == nil, "web view left of the fold: \(narrow.summary)")

        // Fully open keeps an inactive band and lays out flat, as today; so does the cover screen.
        for (divisions, bounds, name) in [([landscapeBand], landscape, "fully open landscape"),
                                          ([portraitBand], portrait, "fully open portrait"),
                                          ([], cover, "closed cover screen")] {
            let flat = HingeLayout(folded: false, divisions: divisions, bounds: bounds)
            expect(flat.posture == .flat && flat.line == nil, "\(name): \(flat.summary)")
        }
        expect(HingeLayout.script(for: HingeLayout(folded: false, divisions: [landscapeBand], bounds: landscape)) ==
               "(function(){var s=document.documentElement.style;s.setProperty('--fluux-device-posture','flat');s.removeProperty('--fluux-hinge-x');s.removeProperty('--fluux-hinge-y');s.removeProperty('--fluux-hinge-margin');})();",
               "flat script")

        // A device without a hinge never sets anything.
        expect(HingeLayout.script(for: nil) ==
               "(function(){var s=document.documentElement.style;s.removeProperty('--fluux-device-posture');s.removeProperty('--fluux-hinge-x');s.removeProperty('--fluux-hinge-y');s.removeProperty('--fluux-hinge-margin');})();",
               "no hinge script")

        print("Hinge layout passed")
    }
}
