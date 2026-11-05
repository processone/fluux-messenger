/** FLM-393: the frontend reports mounted shells and retires its client only.
 * Native code owns drawing proof, deadlines, retry decisions and recovery UI.
 */
import { platform } from '@/platform'

const enabled = () => platform().shell === 'desktop' && platform().os === 'macos'

// Capture once per document, before shell effects. An outgoing page must never
// query a fresh generation just because cleanup caused it to render login.
let attempt: Promise<number | null> | undefined
let retiringForStartup = false
export const isStartupRecoveryDisconnect = () => retiringForStartup
export function startupAttempt(): Promise<number | null> {
  if (!enabled()) return Promise.resolve(null)
  return attempt ??= import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke<number | null>('startup_attempt'))
    .catch(() => null)
}

export async function reportStartupShell(): Promise<void> {
  const generation = await startupAttempt()
  if (generation == null) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('startup_shell_ready', { generation }).catch(() => {})
}

/** One owner per page; no stores, logout, cache clearing or secret changes. */
export function installStartupCleanup(disconnect: () => Promise<void>): () => void {
  if (!enabled()) return () => {}
  let disposed = false
  let pending = false
  let unlisten: (() => void) | undefined
  void import('@tauri-apps/api/event').then(async ({ listen }) => {
    const remove = await listen<number>('startup-recovery-cleanup', async ({ payload: generation }) => {
      if (disposed || pending) return
      pending = true
      // Disconnect mounts LoginScreen. Its relogin effects must not reload or
      // reconnect this retiring page before native code receives the ack.
      retiringForStartup = true
      sessionStorage.removeItem('__wry_was_online')
      let succeeded = false
      try { await disconnect(); succeeded = true } catch { /* A timely explicit failure remains terminal; only an acknowledgement timeout may use the native fallback. */ }
      const { invoke } = await import('@tauri-apps/api/core')
      if (!disposed) await invoke('startup_cleanup_complete', { generation, succeeded }).catch(() => {})
    })
    if (disposed) remove()
    else unlisten = remove
  }).catch(() => {})
  return () => { disposed = true; unlisten?.(); if (pending) retiringForStartup = false }
}
