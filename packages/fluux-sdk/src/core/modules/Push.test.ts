/**
 * Push Module Tests
 *
 * XEP-0357 push through an app server: account support discovery, device
 * registration with the app server (XEP-0050 command) and enabling/disabling
 * push on the user's server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient, bindStoresForTesting } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  getDefaultIQResponse,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

let mockXmppClientInstance: MockXmppClient

vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

import { client as xmppClientFactory } from '@xmpp/client'

interface Built {
  name: string
  attrs: Record<string, string>
  children: unknown[]
}

const child = (el: Built, name: string): Built | undefined =>
  (el.children.flat() as Built[]).find((c) => c && typeof c === 'object' && c.name === name)

const text = (el: Built | undefined): string | undefined => {
  const value = el && (el.children.flat() as Array<Built | string>).find((c) => typeof c === 'string')
  return typeof value === 'string' ? value : undefined
}

/** Field values of a built `<x xmlns='jabber:x:data'/>` form, keyed by var. */
const formValues = (form: Built): Record<string, string | undefined> =>
  Object.fromEntries(
    (form.children.flat() as Built[])
      .filter((c) => c?.name === 'field')
      .map((field) => [field.attrs.var, text(child(field, 'value'))]),
  )

const resultForm = (fields: Record<string, string>) =>
  createMockElement('iq', { type: 'result' }, [
    {
      name: 'command',
      attrs: { xmlns: 'http://jabber.org/protocol/commands', node: 'register-push-apns', status: 'completed' },
      children: [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:data', type: 'result' },
          children: Object.entries(fields).map(([name, value]) => ({
            name: 'field',
            attrs: { var: name },
            children: [{ name: 'value', text: value }],
          })),
        },
      ],
    },
  ])

describe('Push Module (XEP-0357)', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  const connectClient = async () => {
    mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
      const defaultResponse = getDefaultIQResponse(iq)
      if (defaultResponse) return defaultResponse
      return createMockElement('iq', { type: 'result' })
    })

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'password',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.clearAllMocks()
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  }

  const sentIQ = (): Built => mockXmppClientInstance.iqCaller.request.mock.calls[0][0]

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)
    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    bindStoresForTesting(xmppClient, mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('checkSupport', () => {
    it('queries the account bare JID and reports support', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' }, [
          {
            name: 'query',
            attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
            children: [{ name: 'feature', attrs: { var: 'urn:xmpp:push:0' } }],
          },
        ]),
      )

      const supported = await xmppClient.push.checkSupport()

      expect(supported).toBe(true)
      expect(sentIQ().attrs.to).toBe('user@example.com')
      expect(child(sentIQ(), 'query')?.attrs.xmlns).toBe('http://jabber.org/protocol/disco#info')
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:push-status', { status: 'available' })
    })

    it('reports an account without the feature as unsupported', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' }, [
          {
            name: 'query',
            attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
            children: [{ name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } }],
          },
        ]),
      )

      expect(await xmppClient.push.checkSupport()).toBe(false)
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:push-status', { status: 'unsupported' })
    })

    it('reports a failed disco query as unsupported', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('timeout'))

      expect(await xmppClient.push.checkSupport()).toBe(false)
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:push-status', { status: 'unsupported' })
    })
  })

  describe('registerDevice', () => {
    it('executes the app server command with the device id and token', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        resultForm({ jid: 'pushgatedev.process-one.net', node: 'c1fa2257', secret: '7745343671' }),
      )

      const registration = await xmppClient.push.registerDevice({
        appServer: 'pushgatedev.process-one.net',
        command: 'register-push-apns',
        deviceId: 'device-123',
        token: 'abcdef',
      })

      const iq = sentIQ()
      expect(iq.attrs).toMatchObject({ type: 'set', to: 'pushgatedev.process-one.net' })
      const command = child(iq, 'command')!
      expect(command.attrs).toMatchObject({
        xmlns: 'http://jabber.org/protocol/commands',
        node: 'register-push-apns',
        action: 'execute',
      })
      const form = child(command, 'x')!
      expect(form.attrs).toMatchObject({ xmlns: 'jabber:x:data', type: 'submit' })
      expect(formValues(form)).toEqual({ 'device-id': 'device-123', token: 'abcdef' })

      expect(registration).toEqual({ jid: 'pushgatedev.process-one.net', node: 'c1fa2257', secret: '7745343671' })
    })

    it('falls back to the queried app server when the result has no jid', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(resultForm({ node: 'n1' }))

      const registration = await xmppClient.push.registerDevice({
        appServer: 'pushgate.process-one.net',
        command: 'register-push-apns',
        deviceId: 'd',
        token: 't',
      })

      expect(registration).toEqual({ jid: 'pushgate.process-one.net', node: 'n1' })
    })

    it('rejects a result without a node', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(resultForm({ jid: 'pushgate.process-one.net' }))

      await expect(
        xmppClient.push.registerDevice({
          appServer: 'pushgate.process-one.net',
          command: 'register-push-apns',
          deviceId: 'd',
          token: 't',
        }),
      ).rejects.toThrow(/node/)
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:push-status', { status: 'failed' })
    })

    it('reports an app server error as failed, with the reason in the console', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('service-unavailable'))

      await expect(
        xmppClient.push.registerDevice({
          appServer: 'pushgatedev.process-one.net',
          command: 'register-push-apns',
          deviceId: 'd',
          token: 't',
        }),
      ).rejects.toThrow()
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:push-status', { status: 'failed' })
      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: 'Push registration with pushgatedev.process-one.net failed: service-unavailable',
        category: 'connection',
      })
    })
  })

  describe('enable', () => {
    it('enables push on the account with the secret as publish option', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await xmppClient.push.enable({ jid: 'pushgatedev.process-one.net', node: 'c1fa2257', secret: '7745343671' })

      const iq = sentIQ()
      expect(iq.attrs.type).toBe('set')
      expect(iq.attrs.to).toBeUndefined()
      const enable = child(iq, 'enable')!
      expect(enable.attrs).toEqual({ xmlns: 'urn:xmpp:push:0', jid: 'pushgatedev.process-one.net', node: 'c1fa2257' })
      const form = child(enable, 'x')!
      expect(form.attrs).toMatchObject({ xmlns: 'jabber:x:data', type: 'submit' })
      expect(formValues(form)).toEqual({
        FORM_TYPE: 'http://jabber.org/protocol/pubsub#publish-options',
        secret: '7745343671',
      })
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:push-status', { status: 'enabled' })
    })

    it('sends no publish options without a secret', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await xmppClient.push.enable({ jid: 'pushgate.process-one.net', node: 'n1' })

      expect(child(child(sentIQ(), 'enable')!, 'x')).toBeUndefined()
    })

    it('reports a refused enable as failed', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('not-allowed'))

      await expect(xmppClient.push.enable({ jid: 'pushgate.process-one.net', node: 'n1' })).rejects.toThrow()
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:push-status', { status: 'failed' })
    })
  })

  describe('disable', () => {
    it('disables push for the registered node', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(createMockElement('iq', { type: 'result' }))

      await xmppClient.push.disable({ jid: 'pushgate.process-one.net', node: 'n1', secret: 's' })

      const disable = child(sentIQ(), 'disable')!
      expect(disable.attrs).toEqual({ xmlns: 'urn:xmpp:push:0', jid: 'pushgate.process-one.net', node: 'n1' })
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:push-status', { status: 'available' })
    })
  })
})
