import { describe, it, expect, vi } from 'vitest'
import {
  installUpdateReadyDetection,
  dispatchUpdateReady,
  applyWaitingUpdate,
  createFocusUpdateChecker,
} from './serviceWorkerUpdate'

/**
 * Minimal stand-in for a ServiceWorker: exposes a mutable `state`, records the
 * `statechange` listener, and spies `postMessage`.
 */
function createFakeWorker(initialState: string) {
  let stateChange: (() => void) | null = null
  return {
    state: initialState,
    postMessage: vi.fn(),
    addEventListener(type: string, cb: () => void) {
      if (type === 'statechange') stateChange = cb
    },
    setState(next: string) {
      this.state = next
      stateChange?.()
    },
  }
}

/**
 * Minimal stand-in for a ServiceWorkerRegistration: `waiting`/`installing`
 * workers plus a fireable `updatefound` event.
 */
function createFakeRegistration() {
  let updateFound: (() => void) | null = null
  return {
    waiting: null as ReturnType<typeof createFakeWorker> | null,
    installing: null as ReturnType<typeof createFakeWorker> | null,
    addEventListener(type: string, cb: () => void) {
      if (type === 'updatefound') updateFound = cb
    },
    fireUpdateFound() {
      updateFound?.()
    },
  }
}

/** Minimal stand-in for ServiceWorkerContainer's controllerchange event. */
function createFakeContainer() {
  let listener: (() => void) | null = null
  return {
    addEventListener(type: string, cb: () => void) {
      if (type === 'controllerchange') listener = cb
    },
    fireControllerChange() {
      listener?.()
    },
  }
}

describe('installUpdateReadyDetection', () => {
  it('reports a worker already waiting at registration as waiting-at-registration', () => {
    const onReady = vi.fn()
    const reg = createFakeRegistration()
    reg.waiting = createFakeWorker('installed')

    installUpdateReadyDetection(reg as unknown as ServiceWorkerRegistration, () => true, onReady)

    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('waiting-at-registration')
  })

  it('reports an installing worker finishing mid-session (controller exists) as update-found', () => {
    const onReady = vi.fn()
    const reg = createFakeRegistration()
    installUpdateReadyDetection(reg as unknown as ServiceWorkerRegistration, () => true, onReady)

    reg.installing = createFakeWorker('installing')
    reg.fireUpdateFound()
    reg.installing.setState('installed')

    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledWith('update-found')
  })

  it('does not report ready on a first install (installed with no controller)', () => {
    const onReady = vi.fn()
    const reg = createFakeRegistration()
    installUpdateReadyDetection(reg as unknown as ServiceWorkerRegistration, () => false, onReady)

    reg.installing = createFakeWorker('installing')
    reg.fireUpdateFound()
    reg.installing.setState('installed')

    expect(onReady).not.toHaveBeenCalled()
  })

  it('ignores non-installed state transitions', () => {
    const onReady = vi.fn()
    const reg = createFakeRegistration()
    installUpdateReadyDetection(reg as unknown as ServiceWorkerRegistration, () => true, onReady)

    reg.installing = createFakeWorker('installing')
    reg.fireUpdateFound()
    reg.installing.setState('redundant')

    expect(onReady).not.toHaveBeenCalled()
  })
})

describe('dispatchUpdateReady', () => {
  it('applies immediately (safety net) when the update was already waiting at registration', () => {
    const apply = vi.fn()
    const offer = vi.fn()

    dispatchUpdateReady('waiting-at-registration', apply, offer)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(offer).not.toHaveBeenCalled()
  })

  it('offers the update (rail icon) when it arrived mid-session', () => {
    const apply = vi.fn()
    const offer = vi.fn()

    dispatchUpdateReady('update-found', apply, offer)

    expect(offer).toHaveBeenCalledTimes(1)
    expect(offer).toHaveBeenCalledWith(apply)
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('applyWaitingUpdate', () => {
  it('posts SKIP_WAITING to the waiting worker', () => {
    const reg = createFakeRegistration()
    reg.waiting = createFakeWorker('installed')
    const container = createFakeContainer()

    applyWaitingUpdate(
      reg as unknown as ServiceWorkerRegistration,
      container as unknown as ServiceWorkerContainer,
      vi.fn(),
    )

    expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('reloads once when the new worker takes control', () => {
    const reload = vi.fn()
    const reg = createFakeRegistration()
    reg.waiting = createFakeWorker('installed')
    const container = createFakeContainer()

    applyWaitingUpdate(
      reg as unknown as ServiceWorkerRegistration,
      container as unknown as ServiceWorkerContainer,
      reload,
    )
    container.fireControllerChange()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads at most once across repeated controllerchange events', () => {
    const reload = vi.fn()
    const reg = createFakeRegistration()
    reg.waiting = createFakeWorker('installed')
    const container = createFakeContainer()

    applyWaitingUpdate(
      reg as unknown as ServiceWorkerRegistration,
      container as unknown as ServiceWorkerContainer,
      reload,
    )
    container.fireControllerChange()
    container.fireControllerChange()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there is no waiting worker (no reload on unrelated controllerchange)', () => {
    const reload = vi.fn()
    const reg = createFakeRegistration()
    const container = createFakeContainer()

    applyWaitingUpdate(
      reg as unknown as ServiceWorkerRegistration,
      container as unknown as ServiceWorkerContainer,
      reload,
    )
    container.fireControllerChange()

    expect(reload).not.toHaveBeenCalled()
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
