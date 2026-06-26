import { generateConsistentColorHexSync } from '@fluux/sdk'
import { ensureContrast } from './contrastColor'

/**
 * Representative light message-row luminance to AA-correct against. Covers the
 * white chat surface and the slightly darker hover row (the harder case).
 */
const LIGHT_ROW_LUMINANCE = 0.80

/**
 * Aurora-tuned per-person sender color. Continuous XEP-0392 hue (deterministic
 * from `identifier`, theme-independent), tuned to luminous jewel tones on the
 * deep base in dark mode, and AA-corrected for the light message rows in light
 * mode. Replaces the raw getConsistentTextColor for sender names so everyone
 * stays distinct in large rooms while harmonizing with Aurora.
 */
export function auroraSenderColor(identifier: string, isDarkMode: boolean): string {
  if (isDarkMode) {
    // Luminous on near-black; AA on resting + hover rows by construction.
    return generateConsistentColorHexSync(identifier, { saturation: 75, lightness: 72 })
  }
  // Vibrant base, then darken intrinsically-light hues until AA on the light rows.
  const base = generateConsistentColorHexSync(identifier, { saturation: 65, lightness: 45 })
  return ensureContrast(base, LIGHT_ROW_LUMINANCE, 4.5)
}
