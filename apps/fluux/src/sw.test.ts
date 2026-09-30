import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isPushSoundEnabled, persistPushSoundEnabled, SOUND_KEY, SOUND_CHANGED_AT_KEY,
} from './utils/pushSoundPreference'

vi.mock('workbox-precaching', () => ({ precacheAndRoute: vi.fn() }))
vi.mock('workbox-routing', () => ({ registerRoute: vi.fn() }))
vi.mock('workbox-strategies', () => ({ CacheFirst: class {} }))
vi.mock('workbox-expiration', () => ({ ExpirationPlugin: class {} }))
vi.mock('workbox-cacheable-response', () => ({ CacheableResponsePlugin: class {} }))

describe('background push sound preference', () => {
  const storedResponses = new Map<string, Response>()
  const localSettings = new Map<string, string>()
  const listeners = new Map<string, (event: unknown) => void>()
  const showNotification = vi.fn()
  const getNotifications = vi.fn()
  const cache = {
    put: vi.fn(async (key: string, response: Response) => {
      storedResponses.set(key, response.clone())
    }),
    match: vi.fn(async (key: string) => storedResponses.get(key)?.clone()),
    delete: vi.fn(async (key: string) => storedResponses.delete(key)),
  }
  const open = vi.fn(async () => cache)

  async function loadWorker(): Promise<void> {
    listeners.clear()
    await import('./sw')
  }

  async function push(): Promise<void> {
    let lifetime: Promise<unknown> | undefined
    listeners.get('push')!({
      data: {
        text: () => 'hello',
        json: () => ({ title: 'Alice', body: 'hello', from: 'alice@example.com' }),
      },
      waitUntil: (promise: Promise<unknown>) => { lifetime = promise },
    })
    expect(lifetime).toBeDefined()
    await lifetime
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    storedResponses.clear()
    localSettings.clear()
    showNotification.mockResolvedValue(undefined)
    getNotifications.mockResolvedValue([])
    open.mockImplementation(async () => cache)
    cache.put.mockImplementation(async (key: string, response: Response) => {
      storedResponses.set(key, response.clone())
    })
    vi.mocked(localStorage.getItem).mockImplementation(key => localSettings.get(key) ?? null)
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => { localSettings.set(key, value) })
    vi.stubGlobal('caches', { open })
    vi.stubGlobal('navigator', { serviceWorker: {}, userAgent: 'Android', language: 'en' })
    vi.stubGlobal('self', {
      __WB_MANIFEST: [],
      addEventListener: (type: string, callback: (event: unknown) => void) => {
        listeners.set(type, callback)
      },
      registration: { showNotification, getNotifications },
      clients: { matchAll: vi.fn().mockResolvedValue([]) },
      navigator,
      location: new URL('https://example.com/fluux/sw.js'),
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([true, false])('restores the existing preference at app startup (%s)', async (enabled) => {
    localSettings.set(SOUND_KEY, String(enabled))
    const { useSettingsStore } = await import('./stores/settingsStore')
    expect(useSettingsStore.getState().soundEnabled).toBe(enabled)
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1))

    await loadWorker()
    await push()

    expect(showNotification).toHaveBeenCalledWith('Alice', expect.objectContaining({ silent: !enabled }))
  })

  it('keeps the changed preference after the app closes and worker restarts', async () => {
    const { useSettingsStore } = await import('./stores/settingsStore')
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(1))
    useSettingsStore.getState().setSoundEnabled(false)
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(2))
    expect(localStorage.setItem).toHaveBeenCalledWith('fluux-sound', 'false')

    vi.resetModules()
    await loadWorker()
    await push()
    expect(showNotification).toHaveBeenLastCalledWith('Alice', expect.objectContaining({ silent: true }))

    useSettingsStore.getState().setSoundEnabled(true)
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(3))
    await push()
    expect(showNotification).toHaveBeenLastCalledWith('Alice', expect.objectContaining({ silent: false }))
  })

  it('migrates an existing sound preference without inventing a change time', async () => {
    storedResponses.set(`/${SOUND_KEY}`, new Response('true'))
    expect(await isPushSoundEnabled()).toBe(true)
    localSettings.set(SOUND_KEY, 'false')

    await import('./stores/settingsStore')
    await vi.waitFor(async () => expect(await isPushSoundEnabled()).toBe(false))

    const stored = await cache.match(`/${SOUND_KEY}`)
    expect(stored?.headers.get(SOUND_CHANGED_AT_KEY)).toBe('0')
    expect(localSettings.has(SOUND_CHANGED_AT_KEY)).toBe(false)
    await loadWorker()
    await push()
    expect(showNotification).toHaveBeenLastCalledWith('Alice', expect.objectContaining({ silent: true }))
  })

  it.each([true, false])('keeps a newer user change when another tab starts with sound %s', async (enabled) => {
    localSettings.set(SOUND_KEY, String(enabled))
    localSettings.set(SOUND_CHANGED_AT_KEY, '100')
    const firstPreference = await import('./utils/pushSoundPreference')
    const firstPersist = vi.spyOn(firstPreference, 'persistPushSoundEnabled')
    const now = vi.spyOn(Date, 'now').mockReturnValue(200)
    try {
      const firstTab = await import('./stores/settingsStore')
      await firstPersist.mock.results[0].value
      expect((await cache.match(`/${SOUND_KEY}`))?.headers.get(SOUND_CHANGED_AT_KEY)).toBe('100')

      vi.resetModules()
      const secondPreference = await import('./utils/pushSoundPreference')
      const secondPersist = vi.spyOn(secondPreference, 'persistPushSoundEnabled')
      try {
        let release!: () => void
        let markStarted!: () => void
        const pending = new Promise<void>((resolve) => { release = resolve })
        const started = new Promise<void>((resolve) => { markStarted = resolve })
        open.mockImplementationOnce(async () => {
          markStarted()
          await pending
          return cache
        })

        await import('./stores/settingsStore')
        await started
        firstTab.useSettingsStore.getState().setSoundEnabled(!enabled)
        await firstPersist.mock.results.at(-1)!.value
        release()
        await secondPersist.mock.results[0].value

        expect(localSettings.get(SOUND_KEY)).toBe(String(!enabled))
        expect(localSettings.get(SOUND_CHANGED_AT_KEY)).toBe('200')
        expect(await secondPreference.isPushSoundEnabled()).toBe(!enabled)
        expect((await cache.match(`/${SOUND_KEY}`))?.headers.get(SOUND_CHANGED_AT_KEY)).toBe('200')

        vi.resetModules()
        await loadWorker()
        await push()
        expect(showNotification).toHaveBeenLastCalledWith('Alice', expect.objectContaining({ silent: enabled }))
        getNotifications.mockRejectedValueOnce(new Error('unavailable'))
        await push()
        expect(showNotification).toHaveBeenLastCalledWith('Fluux Messenger', expect.objectContaining({ silent: enabled }))
      } finally {
        secondPersist.mockRestore()
      }
    } finally {
      firstPersist.mockRestore()
      now.mockRestore()
    }
  })

  it('does not invalidate a newer enabled entry when an older disabled write fails', async () => {
    await persistPushSoundEnabled(true, 200)
    cache.put.mockRejectedValue(new DOMException('Quota exceeded', 'QuotaExceededError'))

    await persistPushSoundEnabled(false, 100)

    expect(cache.delete).not.toHaveBeenCalled()
    expect(await isPushSoundEnabled()).toBe(true)
  })

  it.each(['startup', 'setter'])('invalidates enabled sound despite failed writes during %s', async (source) => {
    await persistPushSoundEnabled(true, 0)
    expect(await isPushSoundEnabled()).toBe(true)

    const settings = source === 'setter' ? await import('./stores/settingsStore') : undefined
    if (settings) await vi.waitFor(() => expect(cache.put).toHaveBeenCalledTimes(2))
    cache.put.mockRejectedValue(new DOMException('Quota exceeded', 'QuotaExceededError'))

    if (settings) settings.useSettingsStore.getState().setSoundEnabled(false)
    else {
      localSettings.set(SOUND_KEY, 'false')
      await import('./stores/settingsStore')
    }
    await vi.waitFor(async () => expect(await isPushSoundEnabled()).toBe(false))

    vi.resetModules()
    await loadWorker()
    await push()
    expect(showNotification).toHaveBeenLastCalledWith('Alice', expect.objectContaining({ silent: true }))

    getNotifications.mockRejectedValueOnce(new Error('unavailable'))
    await push()
    expect(showNotification).toHaveBeenLastCalledWith('Fluux Messenger', expect.objectContaining({ silent: true }))
  })

  it.each([
    ['startup', true],
    ['startup', false],
    ['setter', true],
    ['setter', false],
  ] as const)('keeps the latest choice after a pending %s write (%s)', async (source, enabled) => {
    const preference = await import('./utils/pushSoundPreference')
    const persist = vi.spyOn(preference, 'persistPushSoundEnabled')
    try {
      let settings = source === 'setter' ? await import('./stores/settingsStore') : undefined
      if (settings) await persist.mock.results[0].value

      let release!: () => void
      let markStarted!: () => void
      const pending = new Promise<void>((resolve) => { release = resolve })
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      cache.put.mockImplementationOnce(async (key: string, response: Response) => {
        markStarted()
        await pending
        storedResponses.set(key, response.clone())
      })

      if (settings) settings.useSettingsStore.getState().setSoundEnabled(enabled)
      else {
        localSettings.set(SOUND_KEY, String(enabled))
        settings = await import('./stores/settingsStore')
      }
      const earlierUpdate = persist.mock.results.at(-1)!.value
      await started
      settings.useSettingsStore.getState().setSoundEnabled(!enabled)
      const latestUpdate = persist.mock.results.at(-1)!.value
      release()
      await Promise.all([earlierUpdate, latestUpdate])

      expect(settings.useSettingsStore.getState().soundEnabled).toBe(!enabled)
      expect(localStorage.setItem).toHaveBeenCalledWith(SOUND_KEY, String(!enabled))
      expect(await preference.isPushSoundEnabled()).toBe(!enabled)

      vi.resetModules()
      await loadWorker()
      await push()
      expect(showNotification).toHaveBeenLastCalledWith('Alice', expect.objectContaining({ silent: enabled }))

      getNotifications.mockRejectedValueOnce(new Error('unavailable'))
      await push()
      expect(showNotification).toHaveBeenLastCalledWith('Fluux Messenger', expect.objectContaining({ silent: enabled }))
    } finally {
      persist.mockRestore()
    }
  })

  it('continues preference updates after an earlier persistence failure', async () => {
    open.mockRejectedValueOnce(new Error('storage unavailable'))
    await Promise.all([persistPushSoundEnabled(false, 1), persistPushSoundEnabled(true, 2)])

    expect(await isPushSoundEnabled()).toBe(true)
    await loadWorker()
    await push()
    expect(showNotification).toHaveBeenLastCalledWith('Alice', expect.objectContaining({ silent: false }))
  })

  it.each(['getNotifications', 'showNotification'])('silences the fallback after %s fails', async (failure) => {
    await persistPushSoundEnabled(false, 1)
    if (failure === 'getNotifications') getNotifications.mockRejectedValueOnce(new Error('unavailable'))
    else showNotification.mockRejectedValueOnce(new Error('unavailable'))
    await loadWorker()

    await push()

    expect(showNotification).toHaveBeenLastCalledWith('Fluux Messenger', expect.objectContaining({ silent: true }))
  })

  it('allows sound on the fallback when the preference is enabled', async () => {
    await persistPushSoundEnabled(true, 1)
    getNotifications.mockRejectedValueOnce(new Error('unavailable'))
    await loadWorker()

    await push()

    expect(showNotification).toHaveBeenLastCalledWith('Fluux Messenger', expect.objectContaining({ silent: false }))
  })

  it('defaults to silent before a preference has been mirrored', async () => {
    await loadWorker()
    await push()
    expect(showNotification).toHaveBeenCalledWith('Alice', expect.objectContaining({ silent: true }))
  })

  it('defaults to silent if worker storage is unavailable', async () => {
    await persistPushSoundEnabled(true, 1)
    open.mockRejectedValue(new Error('storage unavailable'))
    await loadWorker()

    await push()

    expect(showNotification).toHaveBeenCalledWith('Alice', expect.objectContaining({ silent: true }))
  })

  it('leaves in-app settings usable when persistence is unavailable', async () => {
    open.mockRejectedValue(new Error('storage unavailable'))
    const { useSettingsStore } = await import('./stores/settingsStore')

    expect(() => useSettingsStore.getState().setSoundEnabled(false)).not.toThrow()
    expect(useSettingsStore.getState().soundEnabled).toBe(false)
    expect(await isPushSoundEnabled()).toBe(false)
  })

  it('does not write worker storage on platforms without service workers', async () => {
    vi.stubGlobal('navigator', {})
    await persistPushSoundEnabled(false, 1)
    expect(open).not.toHaveBeenCalled()
  })
})
