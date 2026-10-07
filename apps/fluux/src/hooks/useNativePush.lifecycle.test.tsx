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
import { disableNativePush, enableNativePush, requestNativePushRegistration, useNativePush } from './useNativePush'

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
    sendIQ: async (iq: Element) => {
      requests.push(iq)
      await onIQ(iq)
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
  expect(requests.at(-1)?.getChild('disable', 'urn:xmpp:push:0')?.attrs.node).toBe('new-node')
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
})

it('keeps the registration retryable when disabling fails', async () => {
  const { push } = registrar(async () => { throw new Error('offline') })
  localStorage.setItem('fluux-push-registration', JSON.stringify(registration))
  await expect(disableNativePush(push)).rejects.toThrow('offline')
  expect(connectionStore.getState().webPushEnabled).toBe(true)
  expect(JSON.parse(localStorage.getItem('fluux-push-registration')!)).toEqual(registration)
})
