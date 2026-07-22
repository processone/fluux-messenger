export type TransparencyMode = 'full' | 'reduced' | 'system'
export type ResolvedTransparency = 'full' | 'reduced'

/**
 * Resolve the effective transparency for the current theme + user setting.
 *
 * Reduced-wins: a theme may FORCE reduced transparency (the "Pure" theme does,
 * so its glass surfaces render solid), but a theme can never force `full` over a
 * user or OS `reduced` preference. When the theme is neutral, the user's own
 * setting decides ('system' consults the OS query and the GPU probe).
 */
export function resolveTransparency(opts: {
  themeWantsReduced: boolean
  transparencyMode: TransparencyMode
  systemReducedMatches: boolean
  /**
   * True when the GPU probe found a software rasteriser, so backdrop-filter will
   * not paint and glass would degrade into a bare see-through hole.
   *
   * Deliberately weighted exactly like the OS prefers-reduced-transparency
   * signal rather than like a theme's forced-reduced: it decides in 'system'
   * mode only. The probe reads a renderer STRING, which is a proxy and can be
   * wrong — an explicit 'full' must stay available as an escape hatch.
   */
  compositorCannotBlur: boolean
}): ResolvedTransparency {
  if (opts.themeWantsReduced) return 'reduced'
  if (opts.transparencyMode === 'reduced') return 'reduced'
  if (opts.transparencyMode === 'full') return 'full'
  return opts.systemReducedMatches || opts.compositorCannotBlur ? 'reduced' : 'full'
}
