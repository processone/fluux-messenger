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
  /** CSS variable overrides keyed by mode */
  variables: {
    dark?: Record<string, string>
    light?: Record<string, string>
  }
  /** Preview swatch colors for the theme picker UI (3-5 hex values) */
  swatches?: {
    dark?: string[]
    light?: string[]
  }
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
