/** iOS expires a background task after about 30 seconds; stop waiting before it does. */
const BACKGROUND_BUDGET_MS = 25_000

const sends = new Set<Promise<unknown>>()

/** Registers a send (upload included) the app should finish before the OS suspends it. */
export function trackSend<T>(send: Promise<T>): Promise<T> {
  sends.add(send)
  const forget = () => { sends.delete(send) }
  send.then(forget, forget)
  return send
}

/**
 * Resolves once no tracked send runs and the server has acknowledged every sent stanza.
 * A send resolves after its stanza is queued, so the acknowledgement covers it.
 */
export async function sendsSettled(whenSentAcknowledged: () => Promise<void>): Promise<void> {
  while (sends.size > 0) await Promise.allSettled([...sends])
  await whenSentAcknowledged()
}

/** Keeps the app running in the background until pending sends settle, within the OS budget. */
export async function finishSendsInBackground(whenSentAcknowledged: () => Promise<void>): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const { id } = await invoke<{ id: number }>('plugin:background-task|begin')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      sendsSettled(whenSentAcknowledged),
      new Promise<void>(resolve => { timer = setTimeout(resolve, BACKGROUND_BUDGET_MS) }),
    ])
  } finally {
    clearTimeout(timer)
    await invoke('plugin:background-task|end', { id })
  }
}
