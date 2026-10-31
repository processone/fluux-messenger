import { act } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * Waits for the dynamic imports a render or event has started, then lets React
 * apply what they loaded.
 *
 * Such an import gives the test nothing to await, and under Vitest it can be a
 * round-trip to the main process that both workers share. On a busy machine it
 * has outlasted `waitFor`'s one-second deadline (FLM-263). Waiting for the
 * import itself keeps the test independent of that latency.
 */
export async function settleDynamicImports(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled()
  })
}
