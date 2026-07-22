export type TransparencyMode = 'full' | 'reduced' | 'system'
export type ResolvedTransparency = 'full' | 'reduced'

/**
 * Resolve the effective transparency for the current theme + user setting.
 *
 * Reduced-wins: a theme may FORCE reduced transparency (the "Pure" theme does,
 * so its glass surfaces render solid), but a theme can never force `full` over a
 * user or OS `reduced` preference. When the theme is neutral, the user's own
 * setting decides ('system' consults the OS prefers-reduced-transparency query).
 */
export function resolveTransparency(opts: {
  themeWantsReduced: boolean
  transparencyMode: TransparencyMode
  systemReducedMatches: boolean
}): ResolvedTransparency {
  if (opts.themeWantsReduced) return 'reduced'
  if (opts.transparencyMode === 'reduced') return 'reduced'
  if (opts.transparencyMode === 'full') return 'full'
  return opts.systemReducedMatches ? 'reduced' : 'full'
}
