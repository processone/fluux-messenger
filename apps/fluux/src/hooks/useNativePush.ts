import { useEffect } from 'react'
import { connectionStore, consoleStore, generateUUID, useXMPPContext } from '@fluux/sdk'
import type { PushAppServerRegistration, PushDeviceRegistrationRequest, PushStatus } from '@fluux/sdk'
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
  disable(registration: PushAppServerRegistration): Promise<void>
}

/** ProcessOne push app servers; each forwards to the APNs environment it is named after. */
export const PUSH_APP_SERVERS: Record<ApnsEnvironment, string> = {
  development: 'pushgatedev.process-one.net',
  production: 'pushgate.process-one.net',
}

const APNS_COMMAND = 'register-push-apns'
const DEVICE_ID_KEY = 'fluux-push-device-id'
const REGISTRATION_KEY = 'fluux-push-registration'
const TOKEN_KEY = 'fluux-push-token'

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

/**
 * Registers the device token with the app server for its APNs environment,
 * then enables push on the user's server.
 */
export async function enableNativePush(
  push: PushRegistrar,
  device: DevicePushToken,
  storage: KeyValueStorage = localStorage,
): Promise<PushAppServerRegistration> {
  const registration = await push.registerDevice({
    appServer: PUSH_APP_SERVERS[device.environment],
    command: APNS_COMMAND,
    deviceId: pushDeviceId(storage),
    token: device.token,
  })
  await push.enable(registration)
  write(storage, REGISTRATION_KEY, JSON.stringify(registration))
  write(storage, TOKEN_KEY, device.token)
  return registration
}

/** Disables the registration made by {@link enableNativePush}, if any. */
export async function disableNativePush(
  push: PushRegistrar,
  storage: KeyValueStorage = localStorage,
): Promise<void> {
  const stored = read(storage, REGISTRATION_KEY)
  if (!stored) return
  const registration = JSON.parse(stored) as PushAppServerRegistration
  await push.disable(registration)
  write(storage, REGISTRATION_KEY, null)
  write(storage, TOKEN_KEY, null)
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

let registering = false

async function register(push: PushRegistrar, device?: DevicePushToken): Promise<void> {
  if (registering) return
  registering = true
  try {
    let token = device
    if (!token) {
      try {
        token = await requestPushToken()
      } catch (err) {
        // The SDK reports app server and server failures; a missing token is the app's to report.
        const message = `Push: no APNs token: ${err instanceof Error ? err.message : String(err)}`
        consoleStore.getState().addEvent(message, 'connection')
        connectionStore.getState().setPushStatus('failed')
        throw err
      }
    }
    await enableNativePush(push, token)
  } catch (err) {
    console.warn('[NativePush] Registration failed:', err)
  } finally {
    registering = false
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
