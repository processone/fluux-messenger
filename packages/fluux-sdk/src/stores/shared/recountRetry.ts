export interface RecountRetryOptions {
  allowActive: boolean
}

type Retry = (options: RecountRetryOptions) => Promise<void>
type Ready = () => boolean

interface PendingRetry {
  allowActive: boolean
  retry: Retry
  ready: Ready
  timer?: ReturnType<typeof setTimeout>
  generation: number
}

/**
 * Schedules one trailing retry after an unread recount observes changing input.
 * A retry that is itself invalidated must not schedule another retry: sustained
 * message traffic must never turn archive recounting into a timer loop.
 */
export function createRecountRetryScheduler(onError: (error: unknown) => void) {
  const pending = new Map<string, PendingRetry>()
  const running = new Map<string, PendingRetry>()
  let generation = 0

  const dispatch = (entityId: string, request: PendingRetry): void => {
    if (generation !== request.generation || pending.get(entityId) !== request) return
    request.timer = undefined
    if (!request.ready()) return

    pending.delete(entityId)
    running.set(entityId, request)
    void request.retry({ allowActive: request.allowActive })
      .catch(onError)
      .finally(() => {
        if (running.get(entityId) === request) {
          running.delete(entityId)
        }
      })
  }

  const arm = (entityId: string, request: PendingRetry): void => {
    if (request.timer !== undefined) return
    request.timer = setTimeout(() => dispatch(entityId, request), 0)
  }

  const schedule = (entityId: string, allowActive: boolean, retry: Retry, ready: Ready = () => true): void => {
    if (running.get(entityId)?.generation === generation) return

    const existing = pending.get(entityId)
    if (existing?.generation === generation) {
      existing.allowActive ||= allowActive
      return
    }

    const scheduledGeneration = generation
    const request: PendingRetry = {
      allowActive,
      retry,
      ready,
      generation: scheduledGeneration,
    }
    pending.set(entityId, request)
    arm(entityId, request)
  }

  const resume = (entityId: string): void => {
    const request = pending.get(entityId)
    if (!request || request.generation !== generation || !request.ready()) return
    arm(entityId, request)
  }

  const clear = (): void => {
    generation++
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer)
    }
    pending.clear()
  }

  const cancel = (entityId: string): void => {
    const request = pending.get(entityId)
    if (request?.timer !== undefined) clearTimeout(request.timer)
    pending.delete(entityId)
    running.delete(entityId)
  }

  return { schedule, resume, cancel, clear }
}
