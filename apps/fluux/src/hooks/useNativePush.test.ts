import { describe, it, expect, vi } from 'vitest'
import type { PushAppServerRegistration } from '@fluux/sdk'
import {
  disableNativePush,
  enableNativePush,
  pushDeviceId,
  shouldRegister,
  type PushRegistrar,
} from './useNativePush'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

const assigned: PushAppServerRegistration = { jid: 'pushgatedev.process-one.net', node: 'n1', secret: 's1' }

function registrar(): PushRegistrar & { [K in keyof PushRegistrar]: ReturnType<typeof vi.fn> } {
  return {
    registerDevice: vi.fn().mockResolvedValue(assigned),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
  }
}

describe('enableNativePush', () => {
  it('registers a development token with the sandbox app server, then enables push', async () => {
    const push = registrar()
    const storage = memoryStorage()

    await enableNativePush(push, { token: 'abc', environment: 'development' }, storage)

    expect(push.registerDevice).toHaveBeenCalledWith({
      appServer: 'pushgatedev.process-one.net',
      command: 'register-push-apns',
      deviceId: storage.values.get('fluux-push-device-id'),
      token: 'abc',
    })
    expect(push.enable).toHaveBeenCalledWith(assigned)
    expect(push.registerDevice.mock.invocationCallOrder[0]).toBeLessThan(push.enable.mock.invocationCallOrder[0])
  })

  it('registers a production token with the production app server', async () => {
    const push = registrar()

    await enableNativePush(push, { token: 'abc', environment: 'production' }, memoryStorage())

    expect(push.registerDevice).toHaveBeenCalledWith(expect.objectContaining({ appServer: 'pushgate.process-one.net' }))
  })

  it('keeps one device id across registrations', async () => {
    const push = registrar()
    const storage = memoryStorage()

    await enableNativePush(push, { token: 'a', environment: 'development' }, storage)
    await enableNativePush(push, { token: 'b', environment: 'development' }, storage)

    const [first, second] = push.registerDevice.mock.calls.map(([request]) => request.deviceId)
    expect(first).toEqual(expect.any(String))
    expect(second).toBe(first)
  })

  it('records nothing when the server refuses to enable push', async () => {
    const push = registrar()
    push.enable.mockRejectedValue(new Error('not-allowed'))
    const storage = memoryStorage()

    await expect(enableNativePush(push, { token: 'abc', environment: 'development' }, storage)).rejects.toThrow()
    expect(storage.values.has('fluux-push-registration')).toBe(false)
    expect(storage.values.has('fluux-push-token')).toBe(false)
  })
})

describe('disableNativePush', () => {
  it('disables the recorded registration and forgets it', async () => {
    const push = registrar()
    const storage = memoryStorage()
    await enableNativePush(push, { token: 'abc', environment: 'development' }, storage)

    await disableNativePush(push, storage)

    expect(push.disable).toHaveBeenCalledWith(assigned)
    expect(storage.values.has('fluux-push-registration')).toBe(false)
    // The installation keeps its identity for the next registration.
    expect(storage.values.has('fluux-push-device-id')).toBe(true)
  })

  it('does nothing without a recorded registration', async () => {
    const push = registrar()

    await disableNativePush(push, memoryStorage())

    expect(push.disable).not.toHaveBeenCalled()
  })
})

describe('shouldRegister', () => {
  const device = { token: 'abc', environment: 'development' as const }

  it('registers when the account supports push or a registration failed', () => {
    expect(shouldRegister('available', true, undefined, memoryStorage())).toBe(true)
    expect(shouldRegister('failed', true, undefined, memoryStorage())).toBe(true)
  })

  it('never registers while push is turned off', () => {
    expect(shouldRegister('available', false, device, memoryStorage())).toBe(false)
  })

  it('waits for the account support check', () => {
    expect(shouldRegister('unknown', true, device, memoryStorage())).toBe(false)
    expect(shouldRegister('unsupported', true, device, memoryStorage())).toBe(false)
  })

  it('registers again once enabled only for a new token', () => {
    const storage = memoryStorage({ 'fluux-push-token': 'abc' })
    expect(shouldRegister('enabled', true, device, storage)).toBe(false)
    expect(shouldRegister('enabled', true, { ...device, token: 'new' }, storage)).toBe(true)
    expect(shouldRegister('enabled', true, undefined, storage)).toBe(false)
  })
})

describe('pushDeviceId', () => {
  it('still answers when storage is unavailable', () => {
    const broken = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    expect(pushDeviceId(broken)).toEqual(expect.any(String))
  })
})
