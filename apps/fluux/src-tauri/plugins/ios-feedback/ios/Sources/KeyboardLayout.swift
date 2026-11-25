import CoreGraphics

// Frame and bounds must share window coordinates. A floating keyboard can overlap the bottom
// without covering the home-indicator edge across the window.
func isDockedKeyboard(_ frame: CGRect, in bounds: CGRect) -> Bool {
    let overlap = frame.intersection(bounds)
    return !overlap.isNull && overlap.height > 0
        && frame.minX <= bounds.minX + 1 && frame.maxX >= bounds.maxX - 1
        && frame.maxY >= bounds.maxY - 1
}
