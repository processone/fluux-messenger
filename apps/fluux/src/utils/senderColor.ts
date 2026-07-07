import { generateConsistentColorHexSync } from '@fluux/sdk'
import { ensureContrast, ensureContrastOnDark } from './contrastColor'

/**
 * Representative light message-row luminance to AA-correct against. Covers the
 * white chat surface and the slightly darker hover row (the harder case).
 */
const LIGHT_ROW_LUMINANCE = 0.80

/**
 * Conservative dark chat-surface luminance to AA-correct against. The palette is
 * theme-independent, so it must clear AA on the LIGHTEST dark surface any theme
 * ships, not just Aurora's near-black (lum ~0.008). The lightest dark chat-bg in
 * the built-ins is Nord's #434c5e (lum ~0.072); 0.08 covers it with margin, so a
 * sender corrected here clears AA on every darker surface too. Guarded per theme
 * in themeContrast.test.ts.
 */
const DARK_ROW_LUMINANCE = 0.08

/**
 * Aurora-tuned per-person sender color. Continuous XEP-0392 hue (deterministic
 * from `identifier`, theme-independent), tuned to luminous jewel tones on the
 * deep base in dark mode, and AA-corrected for the light message rows in light
 * mode. Replaces the raw getConsistentTextColor for sender names so everyone
 * stays distinct in large rooms while harmonizing with Aurora.
 */
/**
 * The identity a nick's color is derived from. Prefer the XEP-0421 occupant-id
 * (stable per real user within a room, shared across their devices, and present
 * even in anonymous rooms), then the real bare JID, and only fall back to the
 * nick string when no stable identity is known. Seeding on identity rather than
 * the raw nick means an impersonator using a look-alike nick (padded / hidden
 * characters) still renders in a *different* color than the person they mimic.
 * A single precedence, used at every color site, keeps one person one color
 * across the occupant list, message authors, mentions and reply quotes.
 */
export function nickColorSeed(opts: { occupantId?: string; bareJid?: string; nick: string }): string {
  return opts.occupantId || opts.bareJid || opts.nick
}

export function auroraSenderColor(identifier: string, isDarkMode: boolean): string {
  if (isDarkMode) {
    // Luminous on near-black; lighten intrinsically-dark hues until they clear AA
    // on the lightest dark surface a theme may use (Nord/Catppuccin run brighter
    // than Aurora's deep ink).
    const base = generateConsistentColorHexSync(identifier, { saturation: 75, lightness: 72 })
    return ensureContrastOnDark(base, DARK_ROW_LUMINANCE, 4.5)
  }
  // Vibrant base, then darken intrinsically-light hues until AA on the light rows.
  const base = generateConsistentColorHexSync(identifier, { saturation: 65, lightness: 45 })
  return ensureContrast(base, LIGHT_ROW_LUMINANCE, 4.5)
}
