import { describe, expect, it, vi } from 'vitest'
import { executeWithConcurrency } from './concurrencyUtils'

describe('executeWithConcurrency', () => {
  it('should process all items', async () => {
    const processed: number[] = []
    const items = [1, 2, 3, 4, 5]

    await executeWithConcurrency(
      items,
      async (item) => {
        processed.push(item)
      },
      3
    )

    expect(processed).toHaveLength(5)
    expect(processed).toContain(1)
    expect(processed).toContain(5)
  })

  it('should handle empty array', async () => {
    const operation = vi.fn()

    await executeWithConcurrency([], operation, 3)

    expect(operation).not.toHaveBeenCalled()
  })

  it('should respect concurrency limit', async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0
    const concurrencyLimit = 2

    await executeWithConcurrency(
      [1, 2, 3, 4],
      async () => {
        currentConcurrent++
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
        await new Promise((resolve) => setTimeout(resolve, 50))
        currentConcurrent--
      },
      concurrencyLimit
    )

    expect(maxConcurrent).toBeLessThanOrEqual(concurrencyLimit)
  })

  it('should handle operation errors gracefully', async () => {
    const processed: number[] = []
    const items = [1, 2, 3]

    await executeWithConcurrency(
      items,
      async (item) => {
        if (item === 2) {
          throw new Error('Test error')
        }
        processed.push(item)
      },
      3
    )

    // Should process other items despite error
    expect(processed).toContain(1)
    expect(processed).toContain(3)
    expect(processed).not.toContain(2)
  })

  it('should use default concurrency of 3', async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0

    await executeWithConcurrency([1, 2, 3, 4, 5], async () => {
      currentConcurrent++
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
      await new Promise((resolve) => setTimeout(resolve, 50))
      currentConcurrent--
    })

    expect(maxConcurrent).toBeLessThanOrEqual(3)
  })

  it('should wait for all operations to complete before returning', async () => {
    const completed: number[] = []

    await executeWithConcurrency([1, 2, 3], async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item * 10))
      completed.push(item)
    })

    // All should be completed by the time the function returns
    expect(completed).toHaveLength(3)
  })
})
