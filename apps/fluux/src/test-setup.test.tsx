import { describe, test, expect } from 'vitest'

/**
 * The default DOM environment must report an unsettled <img> the way a browser
 * does. Application code reads `complete && naturalWidth === 0` as "the load
 * finished and failed"; an environment that reports it for an image it never
 * fetched makes every avatar collapse to its fallback, and the failure surfaces
 * far from its cause.
 */
describe('DOM environment fidelity', () => {
  test('a freshly sourced image is not yet complete', () => {
    const img = document.createElement('img')
    img.src = 'blob:some-url'
    expect(img.complete).toBe(false)
  })
})
