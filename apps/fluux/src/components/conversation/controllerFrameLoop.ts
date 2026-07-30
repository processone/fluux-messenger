import type { ReassertLoopHandle } from './reassertLoopMonitor'

export interface ControllerFrameLoop {
  schedule: (callback: () => void) => void
  recordFrame: (wrote: boolean) => void
  finish: () => void
}

export interface ControllerFrameLoopLease {
  isCurrent: () => boolean
}

export interface ControllerFrameLoopRegistration {
  raf: number
  finish: () => void
}

export interface ControllerFrameLoopRegistry {
  current: ControllerFrameLoopRegistration | null
}

export interface CreateControllerFrameLoopOptions {
  lease: ControllerFrameLoopLease
  supersede: () => void
  beginHandle: () => ReassertLoopHandle
  registry: ControllerFrameLoopRegistry
  requestFrame: (callback: () => void) => number
  cancelFrame: (id: number) => void
  now: () => number
  warn: (warning: string) => void
  lifecycle?: ControllerFrameLoopLifecycle
}

export interface ControllerFrameLoopLifecycle {
  onStart?: () => void
  onFrame?: () => void
  onFinish?: () => void
}

/**
 * Browser-facing rAF adapter shared by every controller-owned scroll reconciler.
 *
 * The controller owns semantic generations and convergence. This adapter owns the concrete
 * scheduled frame and diagnostic handle so the hook does not grow another lifecycle machine.
 */
export function createControllerFrameLoop(
  options: CreateControllerFrameLoopOptions,
): ControllerFrameLoop | null {
  if (!options.lease.isCurrent()) return null
  options.supersede()
  const handle = options.beginHandle()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    const activeLoop = options.registry.current
    try {
      if (activeLoop?.finish === finish) {
        try {
          if (activeLoop.raf !== 0) options.cancelFrame(activeLoop.raf)
        } finally {
          options.registry.current = null
        }
      }
    } finally {
      try {
        handle.end()
      } finally {
        options.lifecycle?.onFinish?.()
      }
    }
  }
  const entry: ControllerFrameLoopRegistration = {
    raf: 0,
    finish,
  }
  options.registry.current = entry
  try {
    options.lifecycle?.onStart?.()
  } catch (error) {
    finish()
    throw error
  }
  return {
    schedule: (callback: () => void) => {
      if (finished) return
      if (!options.lease.isCurrent()) {
        finish()
        return
      }
      try {
        entry.raf = options.requestFrame(() => {
          entry.raf = 0
          if (finished) return
          if (!options.lease.isCurrent()) {
            finish()
            return
          }
          try {
            callback()
          } catch (error) {
            finish()
            throw error
          }
        })
      } catch (error) {
        finish()
        throw error
      }
    },
    recordFrame: (wrote: boolean) => {
      if (finished) return
      if (!options.lease.isCurrent()) {
        finish()
        return
      }
      options.lifecycle?.onFrame?.()
      const warning = handle.frame(options.now(), wrote)
      if (warning) options.warn(warning)
    },
    finish,
  }
}
