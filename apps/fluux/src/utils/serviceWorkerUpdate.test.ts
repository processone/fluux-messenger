import { describe, it, expect, vi } from 'vitest'
import { installServiceWorkerAutoReload, createFocusUpdateChecker } from './serviceWorkerUpdate'

/**
 * Minimal stand-in for the browser's ServiceWorkerContainer: captures the
 * `controllerchange` listener so the test can fire it, and lets us set the
 * initial `controller` to model "fresh install" (null) vs "already controlled".
 */
function createFakeContainer(initialController: object | null) {
  let listener: (() => void) | null = null
  return {
    controller: initialController,
    addEventListener(type: string, cb: () => void) {
      if (type === 'controllerchange') listener = cb
    },
    fireControllerChange() {
      listener?.()
    },
  }
}

describe('installServiceWorkerAutoReload', () => {
  it('reloads when an updated worker takes control of an already-controlled page', () => {
    const reload = vi.fn()
    const container = createFakeContainer({})
    installServiceWorkerAutoReload(container as unknown as ServiceWorkerContainer, reload)

    container.fireControllerChange()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload on the initial install (first controllerchange with no prior controller)', () => {
    const reload = vi.fn()
    const container = createFakeContainer(null)
    installServiceWorkerAutoReload(container as unknown as ServiceWorkerContainer, reload)

    container.fireControllerChange() // initial clients.claim()

    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads on an update that follows a fresh install', () => {
    const reload = vi.fn()
    const container = createFakeContainer(null)
    installServiceWorkerAutoReload(container as unknown as ServiceWorkerContainer, reload)

    container.fireControllerChange() // initial install — adopt the controller, no reload
    container.fireControllerChange() // later update — reload

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads at most once across repeated controllerchange events', () => {
    const reload = vi.fn()
    const container = createFakeContainer({})
    installServiceWorkerAutoReload(container as unknown as ServiceWorkerContainer, reload)

    container.fireControllerChange()
    container.fireControllerChange()
    container.fireControllerChange()

    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('createFocusUpdateChecker', () => {
  it('signals a check when the document becomes visible', () => {
    const checker = createFocusUpdateChecker({ minIntervalMs: 60_000 })
    expect(checker.shouldCheck('visible', 1000)).toBe(true)
  })

  it('does not signal a check while the document is hidden', () => {
    const checker = createFocusUpdateChecker({ minIntervalMs: 60_000 })
    expect(checker.shouldCheck('hidden', 1000)).toBe(false)
  })

  it('throttles repeated checks within the interval', () => {
    const checker = createFocusUpdateChecker({ minIntervalMs: 60_000 })
    expect(checker.shouldCheck('visible', 0)).toBe(true)
    expect(checker.shouldCheck('visible', 30_000)).toBe(false) // within interval
    expect(checker.shouldCheck('visible', 61_000)).toBe(true) // interval elapsed
  })

  it('does not advance the throttle window on hidden checks', () => {
    const checker = createFocusUpdateChecker({ minIntervalMs: 60_000 })
    expect(checker.shouldCheck('visible', 0)).toBe(true)
    expect(checker.shouldCheck('hidden', 50_000)).toBe(false)
    expect(checker.shouldCheck('visible', 70_000)).toBe(true)
  })
})
