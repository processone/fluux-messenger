export const SOUND_KEY = 'fluux-sound'
export const SOUND_CHANGED_AT_KEY = 'fluux-sound-changed-at'

const CACHE_NAME = 'fluux-settings'
const CACHE_KEY = `/${SOUND_KEY}`
let pendingWrite = Promise.resolve()

/**
 * Mirror the preference for workers, which cannot read localStorage.
 * changedAt is the user's change time in Unix milliseconds (0 for a legacy
 * preference), not the startup time. Writes are serialized within this page;
 * the cached timestamp rejects older changes already visible in storage, but
 * the read and write are not atomic across tabs.
 */
export async function persistPushSoundEnabled(enabled: boolean, changedAt: number): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  pendingWrite = pendingWrite.then(async () => {
    const cache = await caches.open(CACHE_NAME)
    const stored = await cache.match(CACHE_KEY)
    if (Number(stored?.headers.get(SOUND_CHANGED_AT_KEY)) > changedAt) return
    try {
      await cache.put(CACHE_KEY, new Response(String(enabled), {
        headers: { [SOUND_CHANGED_AT_KEY]: String(changedAt) },
      }))
    } catch {
      if (!enabled) await cache.delete(CACHE_KEY)
    }
  }).catch(() => {})
  await pendingWrite
}

export async function isPushSoundEnabled(): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE_NAME)
    const stored = await cache.match(CACHE_KEY)
    return await stored?.text() === 'true'
  } catch {
    return false
  }
}
