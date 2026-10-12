/* eslint-disable @typescript-eslint/triple-slash-reference -- SDK protocol tests need its ambient declarations, which are not importable modules. */
/// <reference path="../../../../packages/fluux-sdk/src/xmpp.d.ts" />
/// <reference path="../../../../packages/fluux-sdk/src/types/ltx.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { connectionStore } from '../../../../packages/fluux-sdk/src/stores/connectionStore'
import { Push } from '../../../../packages/fluux-sdk/src/core/modules/Push'
import type { ModuleDependencies } from '../../../../packages/fluux-sdk/src/core/modules/BaseModule'
import { announcedByPush, disableNativePush, endNativePushSession, prepareNativePushAccount, enableNativePush, requestNativePushRegistration, endPushSession, shouldRegister, useNativePush } from './useNativePush'
import type { DevicePushToken } from './useNativePush'

const context = vi.hoisted(() => ({ client: {} as { push: Push } }))
vi.mock('@fluux/sdk', async () => ({
  connectionStore: (await import('../../../../packages/fluux-sdk/src/stores/connectionStore')).connectionStore,
  consoleStore: { getState: () => ({ addEvent: vi.fn() }) },
  generateUUID: () => 'test-installation',
  useXMPPContext: () => context,
}))
vi.mock('@/platform', () => ({ platform: () => ({ usesNativePush: true }) }))

const device = { token: 'token', environment: 'development' as const }
const registration = { jid: 'push.example.test', node: 'old-node' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function registrar(onIQ: (iq: Element) => Promise<void> = async () => {}) {
  const requests: Element[] = []
  const push = new Push({
    getCurrentJid: () => connectionStore.getState().jid,
    sendIQ: async (iq: Element) => {
      requests.push(iq)
      await onIQ(iq)
      const command = iq.getChild('command', 'http://jabber.org/protocol/commands')
      if (command?.attrs.node.startsWith('unregister-')) return xml('iq', { type: 'result' }, xml('command', { xmlns: 'http://jabber.org/protocol/commands', node: command.attrs.node, status: 'completed' }))
      return xml('iq', { type: 'result' }, xml('command', { xmlns: 'http://jabber.org/protocol/commands' },
        xml('x', { xmlns: 'jabber:x:data', type: 'result' }, xml('field', { var: 'node' }, xml('value', {}, 'new-node')))))
    },
    emitSDK: (event, payload) => {
      if (event === 'connection:push-status' && payload && 'status' in payload) {
        connectionStore.getState().setPushStatus(payload.status as 'available' | 'enabled' | 'failed')
      }
    },
  } as ModuleDependencies)
  context.client = { push }
  return { push, requests }
}

beforeEach(() => {
  localStorage.clear()
  connectionStore.setState({ pushStatus: 'enabled', webPushEnabled: true })
})
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

function tokenBridge(token: Promise<DevicePushToken> = Promise.resolve(device)) {
  const invoke = vi.fn(async (command: string) => command === 'plugin:push|register' ? token : undefined)
  // Exercise the real dynamic import, including concurrent listener registration.
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke, transformCallback: () => 1, unregisterCallback: vi.fn() })
  return invoke
}

it('does not register again when disabling emits available', async () => {
  tokenBridge()
  const { push, requests } = registrar()
  localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
  const hook = renderHook(() => useNativePush())
  await act(async () => { await disableNativePush(push) })
  hook.unmount()
  expect(connectionStore.getState().webPushEnabled).toBe(false)
  expect(requests.map(iq => iq.children[0])).toHaveLength(1)
  expect(requests[0].getChild('disable', 'urn:xmpp:push:0')).toBeDefined()
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
})

it('ignores a token returned after push was switched off', async () => {
  const token = deferred<typeof device>()
  const invoke = tokenBridge(token.promise)
  const { push, requests } = registrar()
  requestNativePushRegistration(push)
  await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === 'plugin:push|register')).toBe(true))
  await disableNativePush(push)
  token.resolve(device)
  await act(async () => { await token.promise })
  expect(requests).toHaveLength(0)
})

it('does not enable when switched off during app-server registration', async () => {
  const reply = deferred<void>()
  const { push, requests } = registrar(iq => iq.getChild('command', 'http://jabber.org/protocol/commands') ? reply.promise : Promise.resolve())
  const enabling = enableNativePush(push, device)
  await waitFor(() => expect(requests).toHaveLength(1))
  const disabling = disableNativePush(push)
  reply.resolve()
  await Promise.all([enabling, disabling])
  expect(requests.some(iq => iq.getChild('enable', 'urn:xmpp:push:0'))).toBe(false)
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
})

it('disables a server enable that was already in flight', async () => {
  const reply = deferred<void>()
  const { push, requests } = registrar(iq => iq.getChild('enable', 'urn:xmpp:push:0') ? reply.promise : Promise.resolve())
  const enabling = enableNativePush(push, device)
  await waitFor(() => expect(requests.some(iq => iq.getChild('enable', 'urn:xmpp:push:0'))).toBe(true))
  const disabling = disableNativePush(push)
  reply.resolve()
  await Promise.all([enabling, disabling])
  expect(requests.find(iq => iq.getChild('disable', 'urn:xmpp:push:0'))?.getChild('disable', 'urn:xmpp:push:0')?.attrs.node).toBe('new-node')
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
})

it('keeps the registration retryable when disabling fails', async () => {
  const { push } = registrar(async () => { throw new Error('offline') })
  localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
  await expect(disableNativePush(push)).rejects.toThrow('offline')
  expect(connectionStore.getState().webPushEnabled).toBe(true)
  expect(JSON.parse(localStorage.getItem('fluux-push-registration')!)).toEqual(registration)
})

it('logout sends the stored XEP-0357 disable and keeps the push preference on', async () => {
  const { push, requests } = registrar()
  connectionStore.setState({ status: 'online', jid: 'me@example.com/phone' })
  localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
  localStorage.setItem('fluux-push-token', 'old-token')
  await endNativePushSession(push)
  const disable = requests[0]?.getChild('disable', 'urn:xmpp:push:0')
  expect(disable?.attrs).toMatchObject({ jid: registration.jid, node: registration.node })
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
  expect(localStorage.getItem('fluux-push-token')).toBeNull()
  expect(connectionStore.getState().webPushEnabled).toBe(true)
})

it.each(['offline', 'error', 'timeout'])('logout clears registration and completes on %s', async mode => {
  vi.useFakeTimers()
  try {
    const { push, requests } = registrar(() => mode === 'timeout' ? new Promise(() => {}) : Promise.reject(new Error('server error')))
    connectionStore.setState({ status: mode === 'offline' ? 'disconnected' : 'online', jid: 'me@example.com' })
    localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
    localStorage.setItem('fluux-push-token', 'old-token')
    const ending = endNativePushSession(push)
    await vi.advanceTimersByTimeAsync(1500)
    await ending
    expect(requests).toHaveLength(mode === 'offline' ? 0 : 1)
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
    expect(localStorage.getItem('fluux-push-token')).toBeNull()
    expect(connectionStore.getState().webPushEnabled).toBe(true)
  } finally { vi.useRealTimers() }
})

it('a timed-out enable cannot restore registration after logout or block fresh registration', async () => {
  vi.useFakeTimers()
  try {
    const reply = deferred<void>()
    const { push } = registrar(iq => iq.getChild('enable', 'urn:xmpp:push:0') ? reply.promise : Promise.resolve())
    connectionStore.setState({ status: 'online', jid: 'me@example.com' })
    const enabling = enableNativePush(push, device)
    await vi.advanceTimersByTimeAsync(0)
    const ending = endNativePushSession(push)
    await vi.advanceTimersByTimeAsync(1500)
    await ending
    reply.resolve()
    await enabling
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
    await prepareNativePushAccount('next@example.com', push)
    await enableNativePush(push, device)
    expect(localStorage.getItem('fluux-push-registration')).not.toBeNull()
  } finally { vi.useRealTimers() }
})

it('account switching disables the previous account before connecting the new one', async () => {
  const { push, requests } = registrar()
  connectionStore.setState({ status: 'online', jid: 'old@example.com/phone' })
  localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
  await prepareNativePushAccount('next@example.com', push)
  expect(requests[0]?.getChild('disable', 'urn:xmpp:push:0')?.attrs.node).toBe(registration.node)
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
})

it.each(['development', 'production'] as const)('logout unregisters the %s gateway after disable, using the stored installation and token', async environment => {
  const { push, requests } = registrar()
  connectionStore.setState({ status: 'online', jid: 'me@example.com' })
  await enableNativePush(push, { ...device, environment })
  requests.length = 0
  await endNativePushSession(push)
  expect(requests).toHaveLength(3)
  expect(requests[0].getChild('disable', 'urn:xmpp:push:0')).toBeDefined()
  expect(requests[1].getChild('query', 'http://jabber.org/protocol/disco#items')?.attrs.node).toBe('http://jabber.org/protocol/commands')
  const command = requests[2].getChild('command', 'http://jabber.org/protocol/commands')!
  expect(command.attrs.node).toBe('unregister-push')
  expect(requests[2].attrs.to).toBe(environment === 'development' ? 'pushdev.fluux.io' : 'push.fluux.io')
  const fields = Object.fromEntries(command.getChild('x', 'jabber:x:data')!.getChildren('field').map(field => [field.attrs.var, field.getChildText('value')]))
  expect(fields).toEqual({ 'device-id': 'test-installation', token: 'token' })
  expect(localStorage.getItem('fluux-push-device-id')).toBe('test-installation')
  expect(localStorage.getItem('fluux-push-account')).toBeNull()
  expect(localStorage.getItem('fluux-push-app-server')).toBeNull()
})

it('gateway failure cannot block logout or restore registration', async () => {
  const { push, requests } = registrar(iq => iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push'
    ? Promise.reject(new Error('service-unavailable')) : Promise.resolve())
  connectionStore.setState({ status: 'online', jid: 'me@example.com' })
  await enableNativePush(push, device)
  requests.length = 0
  await endNativePushSession(push)
  expect(requests[2].getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node).toBe('unregister-push')
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
  expect(connectionStore.getState().webPushEnabled).toBe(true)
})

it('a stalled gateway uses the shared 1500ms logout budget and cannot send after account replacement', async () => {
  vi.useFakeTimers()
  try {
    const discovery = deferred<void>()
    const { push, requests } = registrar(iq => iq.getChild('query', 'http://jabber.org/protocol/disco#items') ? discovery.promise : Promise.resolve())
    connectionStore.setState({ status: 'online', jid: 'me@example.com' })
    await enableNativePush(push, device)
    requests.length = 0
    const ending = endNativePushSession(push)
    await vi.advanceTimersByTimeAsync(1500)
    await ending
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
    connectionStore.setState({ jid: 'next@example.com' })
    discovery.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveLength(2)
    expect(requests.some(iq => iq.getChild('command', 'http://jabber.org/protocol/commands'))).toBe(false)
  } finally { vi.useRealTimers() }
})


it('adopts a legacy registration during offline saved-account restore', async () => {
  const { push, requests } = registrar()
  connectionStore.setState({ status: 'disconnected', jid: null })
  localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
  await prepareNativePushAccount('me@example.com', push)
  expect(localStorage.getItem('fluux-push-account')).toBe('me@example.com')
  expect(localStorage.getItem('fluux-push-registration')).toBe(JSON.stringify(registration))
  expect(requests).toHaveLength(0)
  connectionStore.setState({ status: 'online', jid: 'me@example.com/phone' })
  await enableNativePush(push, device)
  expect(requests[1].getChild('disable', 'urn:xmpp:push:0')?.attrs.node).toBe('old-node')
})

it.each(['online', 'disconnected'] as const)('allows B to register after switching from %s A', async status => {
  const { push, requests } = registrar()
  connectionStore.setState({ status, jid: 'old@example.com' })
  localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
  localStorage.setItem('fluux-push-account', 'old@example.com')
  localStorage.setItem('fluux-push-device-id', 'test-installation')
  await prepareNativePushAccount('next@example.com', push)
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
  if (status === 'online') {
    expect(requests[0].getChild('disable', 'urn:xmpp:push:0')?.attrs.node).toBe('old-node')
    expect(requests[2].getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node).toBe('unregister-push')
  } else expect(requests).toHaveLength(0)
  requests.length = 0
  connectionStore.setState({ status: 'online', jid: 'next@example.com' })
  expect(announcedByPush({ isDelayed: true })).toBe(false)
  await enableNativePush(push, device)
  expect(requests.some(iq => iq.getChild('enable', 'urn:xmpp:push:0'))).toBe(true)
  expect(requests.some(iq => iq.getChild('disable', 'urn:xmpp:push:0'))).toBe(false)
  expect(localStorage.getItem('fluux-push-account')).toBe('next@example.com')
  connectionStore.setState({ jid: 'old@example.com' })
  expect(announcedByPush({ isDelayed: true })).toBe(false)
})


it.each([false, true])('push off unregisters before forgetting and logout sends nothing more (gateway failure: %s)', async fails => {
  const { push, requests } = registrar(iq => fails && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push'
    ? Promise.reject(new Error('service-unavailable')) : Promise.resolve())
  connectionStore.setState({ status: 'online', jid: 'me@example.com' })
  await enableNativePush(push, device)
  requests.length = 0
  await disableNativePush(push)
  expect(requests).toHaveLength(3)
  expect(requests[0].getChild('disable', 'urn:xmpp:push:0')?.attrs.node).toBe('new-node')
  const command = requests[2].getChild('command', 'http://jabber.org/protocol/commands')!
  expect(command.attrs.node).toBe('unregister-push')
  const fields = Object.fromEntries(command.getChild('x', 'jabber:x:data')!.getChildren('field').map(field => [field.attrs.var, field.getChildText('value')]))
  expect(fields).toEqual({ 'device-id': 'test-installation', token: 'token' })
  expect(connectionStore.getState().webPushEnabled).toBe(false)
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
  expect(localStorage.getItem('fluux-push-token')).toBeNull()
  await endNativePushSession(push)
  expect(requests).toHaveLength(3)
})


function legacyRegistration(environment: 'development' | 'production') {
  const old = { jid: environment === 'development' ? 'pushgatedev.process-one.net' : 'pushgate.process-one.net', node: 'legacy-node' }
  localStorage.setItem('fluux-push-registration', JSON.stringify(old))
  localStorage.setItem('fluux-push-device-id', 'existing-installation')
  localStorage.setItem('fluux-push-token', 'legacy-token')
  localStorage.setItem('fluux-push-account', 'me@example.com')
  connectionStore.setState({ status: 'online', jid: 'me@example.com/phone', pushStatus: 'available' })
  return old
}

it.each(['development', 'production'] as const)('migrates the stored %s gateway after registering and enabling the new gateway', async environment => {
  tokenBridge(Promise.resolve({ ...device, environment }))
  const old = legacyRegistration(environment)
  const { requests } = registrar()
  const hook = renderHook(() => useNativePush())
  try {
    await waitFor(() => expect(localStorage.getItem('fluux-push-app-server')).toBe(environment === 'development' ? 'pushdev.fluux.io' : 'push.fluux.io'))
    await waitFor(() => expect(requests).toHaveLength(5))
    expect(requests[2].getChild('disable', 'urn:xmpp:push:0')?.attrs).toMatchObject(old)
    expect(requests[3].attrs.to).toBe(old.jid)
    const unregister = requests[4].getChild('command', 'http://jabber.org/protocol/commands')!
    expect(requests[4].attrs.to).toBe(old.jid)
    expect(unregister.attrs.node).toBe('unregister-push')
    const fields = Object.fromEntries(unregister.getChild('x', 'jabber:x:data')!.getChildren('field').map(field => [field.attrs.var, field.getChildText('value')]))
    expect(fields).toEqual({ 'device-id': 'existing-installation', token: 'legacy-token' })
    const gateway = environment === 'development' ? 'pushdev.fluux.io' : 'push.fluux.io'
    expect(requests[0].attrs.to).toBe(gateway)
    expect(requests[0].getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node).toBe('register-push-apns')
    expect(requests[1].getChild('enable', 'urn:xmpp:push:0')?.attrs).toMatchObject({ jid: gateway, node: 'new-node' })
    expect(JSON.parse(localStorage.getItem('fluux-push-registration')!)).toEqual({ jid: gateway, node: 'new-node' })
    expect(localStorage.getItem('fluux-push-app-server')).toBe(gateway)
    expect(localStorage.getItem('fluux-push-device-id')).toBe('existing-installation')
    expect(localStorage.getItem('fluux-push-token')).toBe('token')
    expect(connectionStore.getState().pushStatus).toBe('enabled')
    expect(shouldRegister(connectionStore.getState().pushStatus, true, { ...device, environment })).toBe(false)
  } finally { hook.unmount() }
})

it.each(['disable', 'unregister'] as const)('migration cleanup errors are non-fatal (%s)', async failure => {
  legacyRegistration('development')
  const { push, requests } = registrar(iq => (failure === 'disable'
    ? iq.getChild('disable', 'urn:xmpp:push:0')
    : iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push')
    ? Promise.reject(new Error('service-unavailable')) : Promise.resolve())
  await enableNativePush(push, device)
  expect(requests).toHaveLength(5)
  expect(requests[1].getChild('enable', 'urn:xmpp:push:0')?.attrs.jid).toBe('pushdev.fluux.io')
  expect(localStorage.getItem('fluux-push-app-server')).toBe('pushdev.fluux.io')
})

it.each(['disable', 'discovery', 'unregister'] as const)('migration cleanup has a shared 1.5-second deadline (%s stalls)', async phase => {
  vi.useFakeTimers()
  try {
    legacyRegistration('production')
    const reply = deferred<void>()
    const { push, requests } = registrar(iq => {
      const stalled = phase === 'disable' ? iq.getChild('disable', 'urn:xmpp:push:0')
        : phase === 'discovery' ? iq.getChild('query', 'http://jabber.org/protocol/disco#items')
        : iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push'
      return stalled ? reply.promise : Promise.resolve()
    })
    const enabling = enableNativePush(push, { ...device, environment: 'production' })
    await vi.advanceTimersByTimeAsync(1499)
    expect(requests[1].getChild('enable', 'urn:xmpp:push:0')?.attrs.node).toBe('new-node')
    await vi.advanceTimersByTimeAsync(1)
    await enabling
    expect(requests[1].getChild('enable', 'urn:xmpp:push:0')?.attrs.jid).toBe('push.fluux.io')
    const count = requests.length
    reply.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveLength(count)
    expect(localStorage.getItem('fluux-push-app-server')).toBe('push.fluux.io')
  } finally { vi.useRealTimers() }
})

it('does not enable after push is switched off during replacement registration', async () => {
  legacyRegistration('development')
  const reply = deferred<void>()
  const { push, requests } = registrar(iq => iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'register-push-apns' ? reply.promise : Promise.resolve())
  const enabling = enableNativePush(push, device)
  await waitFor(() => expect(requests).toHaveLength(1))
  const disabling = disableNativePush(push)
  reply.resolve()
  await Promise.all([enabling, disabling])
  expect(requests.filter(iq => iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'register-push-apns')).toHaveLength(1)
  expect(requests.some(iq => iq.getChild('enable', 'urn:xmpp:push:0'))).toBe(false)
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
})


it.each(['register', 'enable'] as const)('keeps legacy delivery active when replacement %s fails', async phase => {
  const old = legacyRegistration('production')
  let failing = true
  const { push, requests } = registrar(iq => failing && (phase === 'register' ? iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'register-push-apns' : iq.getChild('enable', 'urn:xmpp:push:0'))
    ? Promise.reject(new Error('service-unavailable')) : Promise.resolve())
  await expect(enableNativePush(push, { ...device, environment: 'production' })).rejects.toThrow('service-unavailable')
  expect(JSON.parse(localStorage.getItem('fluux-push-registration')!)).toEqual(old)
  expect(localStorage.getItem('fluux-push-token')).toBe('legacy-token')
  expect(requests.some(iq => iq.getChild('disable', 'urn:xmpp:push:0'))).toBe(false)
  expect(requests.some(iq => iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node.startsWith('unregister-'))).toBe(false)
  failing = false
  requests.length = 0
  await enableNativePush(push, { ...device, environment: 'production' })
  expect(requests).toHaveLength(5)
  expect(requests[2].getChild('disable', 'urn:xmpp:push:0')?.attrs).toMatchObject(old)
  expect(localStorage.getItem('fluux-push-app-server')).toBe('push.fluux.io')
})

it('shares the migration deadline across disable and gateway discovery', async () => {
  vi.useFakeTimers()
  try {
    legacyRegistration('development')
    const disabled = deferred<void>()
    const discovered = deferred<void>()
    const { push, requests } = registrar(iq => iq.getChild('disable', 'urn:xmpp:push:0') ? disabled.promise
      : iq.getChild('query', 'http://jabber.org/protocol/disco#items') ? discovered.promise : Promise.resolve())
    const enabling = enableNativePush(push, device)
    await vi.advanceTimersByTimeAsync(1000)
    disabled.resolve()
    await vi.advanceTimersByTimeAsync(499)
    expect(requests).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    await enabling
    expect(requests).toHaveLength(4)
    expect(requests[1].getChild('enable', 'urn:xmpp:push:0')?.attrs.jid).toBe('pushdev.fluux.io')
    discovered.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveLength(4)
  } finally { vi.useRealTimers() }
})


it.each(['logout', 'account-switch', 'opt-out'] as const)('replacement cleanup bypasses stalled legacy retirement during %s', async action => {
  vi.useFakeTimers()
  try {
    legacyRegistration('production')
    const legacyReply = deferred<void>()
    const { push, requests } = registrar(iq => iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === 'legacy-node'
      ? legacyReply.promise : Promise.resolve())
    const enabling = enableNativePush(push, { ...device, environment: 'production' })
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(localStorage.getItem('fluux-push-registration')!).node).toBe('new-node')
    const ending = action === 'opt-out' ? disableNativePush(push)
      : action === 'account-switch' ? prepareNativePushAccount('other@example.com', push) : endNativePushSession(push)
    await vi.advanceTimersByTimeAsync(1500)
    await ending
    expect(requests.some(iq => iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === 'new-node')).toBe(true)
    const unregister = requests.find(iq => iq.attrs.to === 'push.fluux.io' && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push')!
    expect(unregister).toBeDefined()
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
    expect(connectionStore.getState().pushStatus).toBe('available')
    connectionStore.setState({ pushStatus: 'unsupported' })
    legacyReply.resolve()
    await vi.advanceTimersByTimeAsync(1500)
    await enabling
    expect(connectionStore.getState().pushStatus).toBe('unsupported')
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
    expect(requests.some(iq => iq.attrs.to === 'pushgate.process-one.net' && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push')).toBe(false)
  } finally { vi.useRealTimers() }
})

it.each(['logout', 'opt-out', 'account-switch', 'account-clear'] as const)('revokes both migration nodes when %s starts during enable', async action => {
  vi.useFakeTimers()
  try {
    legacyRegistration('production')
    const enabled = deferred<void>()
    const { push, requests } = registrar(iq => iq.getChild('enable', 'urn:xmpp:push:0') ? enabled.promise : Promise.resolve())
    const enabling = enableNativePush(push, { ...device, environment: 'production' })
    await vi.advanceTimersByTimeAsync(0)
    const ending = action === 'opt-out' ? disableNativePush(push)
      : action === 'account-switch' ? prepareNativePushAccount('other@example.com', push)
      : action === 'account-clear' ? endPushSession(push) : endNativePushSession(push)
    await vi.advanceTimersByTimeAsync(1000)
    enabled.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([enabling, ending])
    expect(requests.some(iq => iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === 'new-node')).toBe(true)
    expect(requests.some(iq => iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === 'legacy-node')).toBe(true)
    expect(requests.some(iq => iq.attrs.to === 'push.fluux.io' && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push')).toBe(true)
    const legacyUnregister = requests.find(iq => iq.attrs.to === 'pushgate.process-one.net' && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push')!
    expect(legacyUnregister).toBeDefined()
    const fields = Object.fromEntries(legacyUnregister.getChild('command', 'http://jabber.org/protocol/commands')!.getChild('x', 'jabber:x:data')!.getChildren('field').map(field => [field.attrs.var, field.getChildText('value')]))
    expect(fields).toEqual({ 'device-id': 'existing-installation', token: 'legacy-token' })
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
    expect(connectionStore.getState().pushStatus).toBe('available')
  } finally { vi.useRealTimers() }
})


it.each(['development', 'production'] as const)('retains failed %s legacy retirement for every later cancellation', async environment => {
  for (const action of ['opt-out', 'logout', 'account-switch', 'account-clear'] as const) {
    localStorage.clear()
    connectionStore.setState({ webPushEnabled: true })
    const old = legacyRegistration(environment)
    let failing = true
    const { push, requests } = registrar(iq => failing && (
      iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === old.node
      || (iq.attrs.to === old.jid && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push'))
      ? Promise.reject(new Error('service-unavailable')) : Promise.resolve())
    await enableNativePush(push, { ...device, environment })
    expect(connectionStore.getState().pushStatus).toBe('enabled')
    expect(requests.some(iq => iq.attrs.to === old.jid && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push')).toBe(true)
    failing = false
    requests.length = 0
    if (action === 'opt-out') await disableNativePush(push)
    else if (action === 'account-switch') await prepareNativePushAccount('other@example.com', push)
    else if (action === 'account-clear') await endPushSession(push)
    else await endNativePushSession(push)
    expect(requests.some(iq => iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === old.node)).toBe(true)
    expect(requests.some(iq => iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === 'new-node')).toBe(true)
    const unregister = requests.find(iq => iq.attrs.to === old.jid && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push')!
    expect(unregister).toBeDefined()
    const fields = Object.fromEntries(unregister.getChild('command', 'http://jabber.org/protocol/commands')!.getChild('x', 'jabber:x:data')!.getChildren('field').map(field => [field.attrs.var, field.getChildText('value')]))
    expect(fields).toEqual({ 'device-id': 'existing-installation', token: 'legacy-token' })
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
  }
})


it.each(['development', 'production'] as const)('cleans retained %s legacy credentials after failed opt-out retirement', async environment => {
  for (const action of ['logout', 'account-switch', 'account-clear'] as const) {
    localStorage.clear()
    connectionStore.setState({ webPushEnabled: true })
    const old = legacyRegistration(environment)
    let failing = true
    const { push, requests } = registrar(iq => failing && (
      iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === old.node
      || (iq.attrs.to === old.jid && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push'))
      ? Promise.reject(new Error('service-unavailable')) : Promise.resolve())
    await enableNativePush(push, { ...device, environment })
    await disableNativePush(push)
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
    expect(requests.filter(iq => iq.getChild('disable', 'urn:xmpp:push:0')?.attrs.node === old.node)).toHaveLength(2)
    requests.length = 0
    connectionStore.setState({ jid: 'unrelated@example.com/phone' })
    await endNativePushSession(push)
    expect(requests).toHaveLength(0)
    connectionStore.setState({ jid: 'me@example.com/phone' })
    failing = false
    requests.length = 0
    if (action === 'account-switch') await prepareNativePushAccount('other@example.com', push)
    else if (action === 'account-clear') await endPushSession(push)
    else await endNativePushSession(push)
    expect(requests[0].getChild('disable', 'urn:xmpp:push:0')?.attrs).toMatchObject(old)
    const unregister = requests.find(iq => iq.attrs.to === old.jid && iq.getChild('command', 'http://jabber.org/protocol/commands')?.attrs.node === 'unregister-push')!
    expect(unregister).toBeDefined()
    const fields = Object.fromEntries(unregister.getChild('command', 'http://jabber.org/protocol/commands')!.getChild('x', 'jabber:x:data')!.getChildren('field').map(field => [field.attrs.var, field.getChildText('value')]))
    expect(fields).toEqual({ 'device-id': 'existing-installation', token: 'legacy-token' })
    expect(localStorage.getItem('fluux-push-registration')).toBeNull()
  }
})
