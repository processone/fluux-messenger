/**
 * Deterministic pseudo-randomness for the Aurora brand mark.
 *
 * The mark must render identically on every launch (brand consistency, stable
 * tests, stable screenshots), so its "organic" star placement comes from a
 * seeded PRNG instead of Math.random().
 */

/** Mulberry32 — tiny, fast, good-enough distribution for visual seeding. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Star {
  cx: number
  cy: number
  r: number
  opacity: number
}

/**
 * Seeded star field inside `region` (SVG user units). Stars stay in the upper
 * 75% of the region and within the radius/opacity ranges from the mark spec.
 */
export function starField(
  seed: number,
  count: number,
  region: { x: number; y: number; w: number; h: number },
): Star[] {
  const rand = mulberry32(seed)
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    stars.push({
      cx: Math.round((region.x + rand() * region.w) * 10) / 10,
      cy: Math.round((region.y + rand() * region.h * 0.75) * 10) / 10,
      r: Math.round((0.5 + rand() * 0.8) * 100) / 100,
      opacity: Math.round((0.2 + rand() * 0.55) * 100) / 100,
    })
  }
  return stars
}
