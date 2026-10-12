import { useEffect } from 'react'
import { connectionStore, consoleStore, generateUUID, useXMPPContext } from '@fluux/sdk'
import type { PushAppServerRegistration, PushDeviceRegistrationRequest, PushDeviceUnregistrationRequest, PushStatus } from '@fluux/sdk'
import { platform } from '@/platform'

/** APNs environment a device token belongs to, as reported by the push plugin. */
export type ApnsEnvironment = 'development' | 'production'

export interface DevicePushToken {
  token: string
  environment: ApnsEnvironment
}

/** The part of `client.push` the native registration uses. */
export interface PushRegistrar {
  registerDevice(request: PushDeviceRegistrationRequest): Promise<PushAppServerRegistration>
  enable(registration: PushAppServerRegistration): Promise<void>
  disable(registration: PushAppServerRegistration, timeoutMs?: number, options?: { preserveStatus?: boolean }): Promise<void>
  unregisterDevice(request: PushDeviceUnregistrationRequest, timeoutMs?: number): Promise<void>
}

/** ProcessOne push app servers; each forwards to the APNs environment it is named after. */
export const PUSH_APP_SERVERS: Record<ApnsEnvironment, string> = {
  development: 'pushdev.fluux.io',
  production: 'push.fluux.io',
}

const LEGACY_PUSH_APP_SERVERS = new Set(['pushgate.process-one.net', 'pushgatedev.process-one.net'])

const APNS_COMMAND = 'register-push-apns'
const DEVICE_ID_KEY = 'fluux-push-device-id'
const REGISTRATION_KEY = 'fluux-push-registration'
const TOKEN_KEY = 'fluux-push-token'
const ACCOUNT_KEY = 'fluux-push-account'
const APP_SERVER_KEY = 'fluux-push-app-server'
const LOGOUT_PUSH_TIMEOUT_MS = 1500
const MIGRATION_PUSH_TIMEOUT_MS = 1500
let activePush: PushRegistrar | undefined

interface RegistrationState {
  generation: number
  session: number
  ending: boolean
  requestingToken?: object
  legacy?: {
    owner: string | null
    registration: PushAppServerRegistration
    deviceId: string | null
    token: string | null
  }
  pending: Promise<void>
}
const registrations = new WeakMap<PushRegistrar, RegistrationState>()
function registrationState(push: PushRegistrar): RegistrationState {
  let state = registrations.get(push)
  if (!state) {
    state = { generation: 0, session: 0, ending: false, pending: Promise.resolve() }
    registrations.set(push, state)
  }
  return state
}

/** Server changes run in order, so an off request can undo an in-flight enable. */
function enqueue<T>(state: RegistrationState, operation: () => Promise<T>): Promise<T> {
  const result = state.pending.then(operation)
  state.pending = result.then(() => {}, () => {})
  return result
}

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function read(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function write(storage: KeyValueStorage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  } catch {
    // The registration is redone on the next fresh session.
  }
}

/**
 * Identifier of this installation. Registering again with it replaces the
 * device's previous token at the app server instead of adding a second one.
 */
export function pushDeviceId(storage: KeyValueStorage = localStorage): string {
  const existing = read(storage, DEVICE_ID_KEY)
  if (existing) return existing
  const created = generateUUID()
  write(storage, DEVICE_ID_KEY, created)
  return created
}

function storedRegistration(storage: KeyValueStorage): PushAppServerRegistration | null {
  const stored = read(storage, REGISTRATION_KEY)
  if (!stored) return null
  try {
    return JSON.parse(stored) as PushAppServerRegistration
  } catch {
    return null
  }
}

async function retireLegacyRegistration(
  push: PushRegistrar,
  previous: PushAppServerRegistration,
  deviceId: string | null,
  token: string | null,
  isCurrent: () => boolean,
  deadline = Date.now() + MIGRATION_PUSH_TIMEOUT_MS,
): Promise<boolean> {
  if (!isCurrent()) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanup = async () => {
    const disabled = await push.disable(previous, Math.max(1, deadline - Date.now()), { preserveStatus: true })
      .then(() => true, () => {
        console.debug('[NativePush] Legacy push disable unavailable')
        return false
      })
    const remaining = deadline - Date.now()
    if (!isCurrent() || remaining <= 0 || !deviceId) return false
    await push.unregisterDevice({
      appServer: previous.jid,
      deviceId,
      ...(token ? { token } : {}),
    }, remaining).catch(() => console.debug('[NativePush] Legacy gateway unregistration unavailable'))
    return disabled && isCurrent()
  }
  try {
    return await Promise.race([
      cleanup(),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())) }),
    ])
  } finally { clearTimeout(timer) }
}

/**
 * Registers the device token with the app server for its APNs environment,
 * then enables push on the user's server.
 */
export async function enableNativePush(
  push: PushRegistrar,
  device: DevicePushToken,
  storage: KeyValueStorage = localStorage,
): Promise<PushAppServerRegistration | undefined> {
  const state = registrationState(push)
  const generation = state.generation
  const session = state.session
  let retirement: Promise<void> | undefined
  const result = await enqueue(state, async () => {
    if (generation !== state.generation || state.ending) return undefined
    const account = connectionStore.getState().jid?.split('/')[0]
    const owner = read(storage, ACCOUNT_KEY)
    if (owner && owner !== account) return undefined
    const previous = storedRegistration(storage)
    const migrating = previous !== null && LEGACY_PUSH_APP_SERVERS.has(previous.jid)
    const previousDeviceId = read(storage, DEVICE_ID_KEY)
    const previousToken = read(storage, TOKEN_KEY)
    const registration = await push.registerDevice({
      appServer: PUSH_APP_SERVERS[device.environment],
      command: APNS_COMMAND,
      deviceId: pushDeviceId(storage),
      token: device.token,
    })
    if (generation !== state.generation || state.ending) return undefined
    if (previous && !migrating) {
      await push.disable(previous).catch((err) => console.warn('[NativePush] Previous registration not disabled:', err))
    }
    if (generation !== state.generation || state.ending) return undefined
    await push.enable(registration)
    if (session !== state.session) return undefined
    if (migrating) state.legacy = { owner: owner ?? account ?? null, registration: previous, deviceId: previousDeviceId, token: previousToken }
    // Even if off was requested during the IQ, retain the enabled node until the
    // queued disable removes it. Otherwise that operation cannot address it.
    write(storage, REGISTRATION_KEY, JSON.stringify(registration))
    write(storage, TOKEN_KEY, device.token)
    write(storage, APP_SERVER_KEY, PUSH_APP_SERVERS[device.environment])
    write(storage, ACCOUNT_KEY, connectionStore.getState().jid?.split('/')[0] ?? null)
    if (migrating) {
      const legacy = state.legacy
      retirement = retireLegacyRegistration(push, previous, previousDeviceId, previousToken,
        () => generation === state.generation && session === state.session && !state.ending
          && account === connectionStore.getState().jid?.split('/')[0])
        .then(addressed => { if (addressed && state.legacy === legacy) state.legacy = undefined })
    }
    return registration
  })
  await retirement
  return result
}

/** Disables the registration made by {@link enableNativePush}, if any. */
export async function disableNativePush(
  push: PushRegistrar,
  storage: KeyValueStorage = localStorage,
  options: { endingSession?: boolean; deadline?: number } = {},
): Promise<void> {
  const state = registrationState(push)
  const generation = ++state.generation
  state.requestingToken = undefined
  const endingSession = options.endingSession ?? false
  const wasEnabled = connectionStore.getState().webPushEnabled
  if (!endingSession) connectionStore.getState().setWebPushEnabled(false)
  try {
    const session = state.session
    await enqueue(state, async () => {
      if (session !== state.session) return
      const registration = storedRegistration(storage)
      const account = connectionStore.getState().jid?.split('/')[0]
      const owner = read(storage, ACCOUNT_KEY)
      if (owner && owner !== account) return
      const legacy = state.legacy && (!state.legacy.owner || state.legacy.owner === account) ? state.legacy : undefined
      if (!registration && !legacy) return
      const deadline = options.deadline ?? Date.now() + LOGOUT_PUSH_TIMEOUT_MS
      const legacyCleanup = legacy ? retireLegacyRegistration(push, legacy.registration, legacy.deviceId, legacy.token,
        () => session === state.session && generation === state.generation
          && account === connectionStore.getState().jid?.split('/')[0], deadline)
        .then(addressed => { if (addressed && state.legacy === legacy) state.legacy = undefined }) : undefined
      if (registration) {
        try {
          if (endingSession) await push.disable(registration, Math.max(1, (options.deadline ?? Date.now()) - Date.now()))
          else await push.disable(registration, legacy ? Math.max(1, deadline - Date.now()) : undefined)
        } catch (error) {
          if (!endingSession) throw error
          console.debug('[NativePush] Logout push disable unavailable')
        }
        if (session !== state.session) return
        const remaining = (legacy ? deadline : options.deadline ?? Date.now() + LOGOUT_PUSH_TIMEOUT_MS) - Date.now()
        const deviceId = read(storage, DEVICE_ID_KEY)
        if (remaining > 0 && deviceId) {
          await push.unregisterDevice({
            appServer: read(storage, APP_SERVER_KEY) ?? registration.jid,
            deviceId,
            ...(read(storage, TOKEN_KEY) ? { token: read(storage, TOKEN_KEY)! } : {}),
          }, remaining).catch(() => console.debug('[NativePush] Gateway unregistration unavailable'))
        }
      }
      await legacyCleanup
      if (session !== state.session) return
      write(storage, REGISTRATION_KEY, null)
      write(storage, TOKEN_KEY, null)
      write(storage, ACCOUNT_KEY, null)
      write(storage, APP_SERVER_KEY, null)
    })
  } catch (error) {
    if (!endingSession && state.generation === generation) connectionStore.getState().setWebPushEnabled(wasEnabled)
    throw error
  }
}

/** Ends this device's push session without changing the user's push preference. */
export async function endNativePushSession(
  push: PushRegistrar | undefined = activePush,
  storage: KeyValueStorage = localStorage,
): Promise<void> {
  const state = push ? registrationState(push) : undefined
  const owner = read(storage, ACCOUNT_KEY) ?? state?.legacy?.owner
  const canClean = push && connectionStore.getState().status === 'online'
    && (!owner || owner === connectionStore.getState().jid?.split('/')[0])
  if (state) { state.ending = true; state.generation++; state.requestingToken = undefined }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (canClean) {
      await Promise.race([
        disableNativePush(push, storage, { endingSession: true, deadline: Date.now() + LOGOUT_PUSH_TIMEOUT_MS }).catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(() => { console.debug('[NativePush] Logout push cleanup timed out'); resolve() }, LOGOUT_PUSH_TIMEOUT_MS) }),
      ])
    }
  } finally {
    clearTimeout(timer)
    if (state) {
      // A late IQ cannot restore local state or keep the next session's queue blocked.
      state.session++
      state.pending = Promise.resolve()
    }
    write(storage, REGISTRATION_KEY, null)
    write(storage, TOKEN_KEY, null)
    write(storage, ACCOUNT_KEY, null)
    write(storage, APP_SERVER_KEY, null)
  }
}

/** Revokes shared notification content before closing or replacing an account. */
export async function endPushSession(push?: PushRegistrar): Promise<void> {
  const disabling = endNativePushSession(push)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const revokeContent = async () => {
      const [{ clearIOSNotificationMirror }, { purgeIOSNotificationPreviews }] = await Promise.all([
        import('@/platform/ios/notificationMirror'), import('@/platform/ios/notificationPreviews'),
      ])
      await Promise.all([clearIOSNotificationMirror().catch(() => {}), purgeIOSNotificationPreviews().catch(() => {})])
    }
    await Promise.race([
      Promise.all([disabling, revokeContent().catch(() => console.debug('[NativePush] Logout notification cleanup unavailable'))]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 2500) }),
    ])
  } catch {
    console.debug('[NativePush] Logout notification cleanup unavailable')
  } finally { clearTimeout(timer) }
}

/** Called before connect changes the SDK's account/transport ownership. */
export async function prepareNativePushAccount(jid: string, push: PushRegistrar | undefined = activePush): Promise<void> {
  if (!platform().usesNativePush) return
  const account = jid.split('/')[0]
  const owner = read(localStorage, ACCOUNT_KEY) ?? (push ? registrationState(push).legacy?.owner : null)
  const previous = owner ?? connectionStore.getState().jid?.split('/')[0]
  if (!owner && storedRegistration(localStorage) && (!previous || previous === account)) {
    write(localStorage, ACCOUNT_KEY, account)
  } else if (previous && previous !== account) await endPushSession(push)
  if (push) registrationState(push).ending = false
}

/**
 * Whether a push has already announced this message. The server stores, and
 * delays, a message for an absent session, which is when it pushes; this
 * device's registration survives app restarts, unlike the session's push status.
 */
export function announcedByPush(
  message: { isDelayed?: boolean },
  storage: KeyValueStorage = localStorage,
): boolean {
  const owner = read(storage, ACCOUNT_KEY)
  return message.isDelayed === true && platform().usesNativePush && read(storage, REGISTRATION_KEY) !== null
    && (!owner || owner === connectionStore.getState().jid?.split('/')[0])
}

/**
 * Whether to register in this push state. Once enabled, only a token that
 * differs from the registered one needs registering again.
 */
export function shouldRegister(
  status: PushStatus,
  enabled: boolean,
  device?: DevicePushToken,
  storage: KeyValueStorage = localStorage,
): boolean {
  if (!enabled) return false
  if (status === 'available' || status === 'failed') return true
  return status === 'enabled' && device !== undefined && device.token !== read(storage, TOKEN_KEY)
}

async function requestPushToken(): Promise<DevicePushToken> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<DevicePushToken>('plugin:push|register')
}

async function register(push: PushRegistrar, device?: DevicePushToken): Promise<void> {
  const state = registrationState(push)
  if (state.ending || state.requestingToken || !connectionStore.getState().webPushEnabled) return
  const request = {}
  const generation = ++state.generation
  state.requestingToken = request
  try {
    let token = device
    if (!token) {
      try {
        token = await requestPushToken()
      } catch (err) {
        if (generation !== state.generation) return
        // The SDK reports app server and server failures; a missing token is the app's to report.
        const message = `Push: no APNs token: ${err instanceof Error ? err.message : String(err)}`
        consoleStore.getState().addEvent(message, 'connection')
        connectionStore.getState().setPushStatus('failed')
        throw err
      }
    }
    if (generation !== state.generation || !connectionStore.getState().webPushEnabled) return
    await enableNativePush(push, token)
  } catch (err) {
    console.warn('[NativePush] Registration failed:', err)
  } finally {
    if (state.requestingToken === request) state.requestingToken = undefined
  }
}

/**
 * Registers for native push from a user action, e.g. re-enabling it in the
 * settings. Asks for notification permission if it was never granted.
 */
export function requestNativePushRegistration(push: PushRegistrar): void {
  if (!platform().usesNativePush) return
  void register(push)
}

/**
 * Keeps this device registered for native push while push is enabled: on every
 * fresh session (the SDK reports the account's support as `available`) and
 * whenever the platform hands over a new device token.
 */
export function useNativePush(): void {
  const { client } = useXMPPContext()

  useEffect(() => {
    if (!platform().usesNativePush) return
    activePush = client.push
    registrationState(client.push).ending = false

    const registerIfEnabled = (device?: DevicePushToken) => {
      const { pushStatus, webPushEnabled } = connectionStore.getState()
      if (shouldRegister(pushStatus, webPushEnabled, device)) void register(client.push, device)
    }

    const unsubscribe = connectionStore.subscribe(
      (state) => state.pushStatus,
      (status) => {
        if (status === 'available') registerIfEnabled()
      },
    )
    if (connectionStore.getState().pushStatus === 'available') registerIfEnabled()

    let disposed = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/core')
      .then(({ addPluginListener }) => addPluginListener<DevicePushToken>('push', 'token', registerIfEnabled))
      .then((listener) => {
        if (disposed) void listener.unregister()
        else unlisten = () => void listener.unregister()
      })
      .catch((err) => console.warn('[NativePush] Token listener unavailable:', err))

    return () => {
      disposed = true
      unsubscribe()
      unlisten?.()
    }
  }, [client])
}
