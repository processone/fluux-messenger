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
import { announcedByPush, disableNativePush, endNativePushSession, prepareNativePushAccount, enableNativePush, requestNativePushRegistration, useNativePush } from './useNativePush'

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

function tokenBridge(token: Promise<typeof device> = Promise.resolve(device)) {
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
  expect(requests[2].attrs.to).toBe(environment === 'development' ? 'pushgatedev.process-one.net' : 'pushgate.process-one.net')
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
