/**
 * Single source of truth for the hollow chat-bubble glyph as placed on the
 * 1024×1024 app-icon canvas. Shared by HollowIconMark (login screen) and
 * asserted against src-tauri/icons/icon-variants/hollow/*.svg by
 * messageBubbleGlyph.test.ts, so the React mark and the rasterized icons cannot
 * drift. Geometry derived in
 * docs/superpowers/specs/2026-07-08-icon-style-build-switch-design.md.
 *
 * PINNED, not imported: this is the historical Lucide MessageCircle (v0.x era) —
 * the exact glyph in the approved login mark. Do NOT import MessageCircle from
 * lucide-react: the installed 1.16.0 ships a redesigned, different-shaped
 * MessageCircle, and a brand icon must not mutate when the library is bumped.
 */
export const MESSAGE_BUBBLE_PATH = 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z'

/** Centers the glyph's measured visual box at the tile center, 56% extent. */
export const GLYPH_TRANSFORM = 'translate(235.41 211.86) scale(24.0304)'

/** Lucide default stroke weight (24-unit space). */
export const GLYPH_STROKE_WIDTH = 2

/**
 * Drop shadow in ABSOLUTE 1024-canvas units. Applied to an unscaled wrapper <g>
 * (never the scaled glyph group) so Cairo (rsvg) and Skia (browser) render it
 * identically — the same renderer-consistency lesson as the seam fix (#926).
 */
export const GLYPH_SHADOW = {
  dy: 10.8,
  stdDeviation: 14.4,
  color: '#160E3A',
  opacity: 0.22,
} as const
