import { describe, it, expect } from 'vitest'
import { importCycles, sdkSourceFiles } from '../importGraph.testHelpers'

/**
 * Stores sit BELOW core in the SDK's dependency order.
 *
 * A store may name core's domain types; it must never end up in an import cycle
 * with core. When it does, no protocol module can be typechecked or reasoned
 * about without the whole state layer coming with it, and the package can no
 * longer describe its own state surface without naming its state library.
 *
 * The ESLint `no-restricted-imports` rule in `eslint.config.js` blocks the easy
 * way back in (a store importing the `../core` barrel, which re-exports
 * XMPPClient). This test covers the rest: a direct import of a core module that
 * imports stores back, however long the path between them.
 *
 * When this fails, the reported cycle names the modules; break the edge that
 * points from a store UP into core, not the one pointing down.
 */
describe('stores layering', () => {
  it('sees the whole SDK source graph', () => {
    expect(sdkSourceFiles().length).toBeGreaterThan(200)
  })

  it('keeps no store in an import cycle with core', () => {
    const mixed = importCycles().filter(
      component =>
        component.some(file => file.startsWith('stores/')) &&
        component.some(file => file.startsWith('core/'))
    )

    expect(mixed).toEqual([])
  })
})
