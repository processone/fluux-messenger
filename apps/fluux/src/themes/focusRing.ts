import { contrastRatio, getLuminance } from '@/utils/contrastColor'

export type FocusRgb = readonly [number, number, number]
export type FocusRgba = readonly [number, number, number, number]
export interface FocusAccent { h: number; s: number; l: number }

/** Surfaces next to the shared keyboard indicator, including flush list rows. */
export const FOCUS_SURFACES = [
  '--fluux-chat-bg', '--fluux-sidebar-bg', '--fluux-bg-hover',
  '--fluux-modal-bg', '--fluux-bg-float',
] as const

/** Composite before measuring: transparent hover is painted on several surfaces. */
export function paintedFocusSurfaces(read: (token: string) => FocusRgba, canvas: FocusRgb): FocusRgb[] {
  const over = (fg: FocusRgba, bg: FocusRgb): FocusRgb => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  ]
  const [chatColor, sidebarColor, hoverColor, dialogColor, popoverColor] = FOCUS_SURFACES.map(read)
  const shell = over(read('--fluux-bg-primary'), canvas)
  const chat = over(chatColor, shell)
  const sidebar = over(sidebarColor, shell)
  // Dialogs and popovers can sit over either content pane. Preserve each real
  // backing surface rather than pretending their alpha channel is opaque.
  const dialogs = [chat, sidebar].map(bg => over(dialogColor, bg))
  const popovers = [chat, sidebar, ...dialogs].map(bg => over(popoverColor, bg))
  const bases = [chat, sidebar, ...dialogs, ...popovers]
  return [...bases, ...bases.map(bg => over(hoverColor, bg))]
}

/** Quantize like the painted sRGB colour before measuring non-text contrast. */
export function focusHslToRgb({ h, s, l }: FocusAccent): FocusRgb {
  const lightness = l / 100
  const a = s / 100 * Math.min(lightness, 1 - lightness)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

/**
 * Keep the accent hue and saturation, moving lightness only as far as necessary
 * to clear 3:1 on every adjacent surface. Dark starts with the existing +8 lift.
 * Try both directions for custom palettes whose surfaces do not match their mode.
 * An arbitrary mixed-light/dark custom palette may admit no single 3:1 colour;
 * in that case retain the candidate with the strongest worst-surface contrast.
 */
export function guardedFocusRing(accent: FocusAccent, mode: 'light' | 'dark', surfaces: readonly FocusRgb[]): FocusRgb {
  const start = Math.min(100, Math.max(0, accent.l + (mode === 'dark' ? 8 : 0)))
  const luminances = surfaces.map(rgb => getLuminance(...rgb))
  const score = (rgb: FocusRgb) => Math.min(...luminances.map(l => contrastRatio(getLuminance(...rgb), l)))
  let best = focusHslToRgb({ ...accent, l: start })
  let bestScore = score(best)
  if (bestScore >= 3) return best
  const direction = mode === 'dark' ? 1 : -1
  for (let step = 1; step <= 100; step++) {
    for (const sign of [direction, -direction]) {
      const l = Math.min(100, Math.max(0, start + sign * step))
      const candidate = focusHslToRgb({ ...accent, l })
      const candidateScore = score(candidate)
      if (candidateScore >= 3) return candidate
      if (candidateScore > bestScore) { best = candidate; bestScore = candidateScore }
    }
  }
  return best
}
