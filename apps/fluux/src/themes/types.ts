/**
 * Theme Definition — describes a complete visual theme for Fluux.
 *
 * Each theme provides CSS variable overrides for dark and/or light mode.
 * Variables follow the 3-tier architecture:
 *   Tier 1 (Foundation): --fluux-base-*, --fluux-accent-*, --fluux-color-*
 *   Tier 2 (Semantic):   --fluux-bg-*, --fluux-text-*, --fluux-status-*, etc.
 *   Tier 3 (Component):  --fluux-sidebar-*, --fluux-chat-*, --fluux-modal-*, etc.
 *
 * Theme authors typically only need to override foundation variables (~15-20)
 * to achieve a complete visual overhaul. Semantic and component variables
 * cascade automatically from foundation values.
 */
/**
 * Accent color preset — provides HSL values for both dark and light modes.
 *
 * Themes can optionally define a curated list of accent presets that pair
 * well with their palette (e.g. Catppuccin's 14 canonical accents).
 * When a theme doesn't provide presets, a built-in default list is used.
 */
export interface AccentPreset {
  /** Display name (e.g. "Mauve", "Sapphire") */
  name: string
  /** HSL values for dark mode */
  dark: { h: number; s: number; l: number }
  /** HSL values for light mode */
  light: { h: number; s: number; l: number }
}

export interface ThemeDefinition {
  /** Unique identifier (kebab-case, e.g. 'nord', 'catppuccin-mocha') */
  id: string
  /** Display name */
  name: string
  /** Author name */
  author: string
  /** Semver version string */
  version: string
  /** Short description */
  description: string
  /**
   * CSS variable overrides keyed by mode.
   *
   * In addition to color variables, themes may override typography variables:
   *   --fluux-font-ui   — UI typeface (default: 'Inter', sans-serif)
   *   --fluux-font-mono  — Monospace typeface (default: monospace)
   *
   * Font overrides should reference system-installed or user-provided fonts
   * (never bundled). Always include a sensible fallback stack ending with
   * the default value, e.g.:
   *   '--fluux-font-ui': '"SF Pro Display", "Segoe UI", system-ui, sans-serif'
   */
  variables: {
    dark?: Record<string, string>
    light?: Record<string, string>
  }
  /**
   * Optional display-optimisation hint. When set to 'reduced', selecting this
   * theme forces the app into reduced-transparency mode (glass surfaces render
   * solid) regardless of the user's transparency setting — used by "Pure" so its
   * true-black / flat-white surfaces are not broken by frosted panels. A theme
   * can only tighten transparency, never loosen it. See resolveTransparency().
   */
  transparency?: 'reduced'
  /** Preview swatch colors for the theme picker UI (3-5 hex values) */
  swatches?: {
    dark?: string[]
    light?: string[]
  }
  /** Curated accent presets that pair well with this theme's palette.
   *  When absent, a built-in default list is shown in the accent picker. */
  accentPresets?: AccentPreset[]
}

/**
 * Snippet state — tracks an individual CSS snippet's toggle state.
 */
export interface SnippetState {
  /** Unique identifier (derived from filename) */
  id: string
  /** Original filename (e.g. 'compact-mode.css') */
  filename: string
  /** Whether the snippet is currently active */
  enabled: boolean
  /** Raw CSS content */
  css: string
}
