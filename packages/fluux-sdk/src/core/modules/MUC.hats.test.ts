/**
 * MUC Hat Management Tests (XEP-0317)
 *
 * Tests for hat CRUD and assignment via XEP-0050 Ad-Hoc Commands:
 * - listHats / createHat / destroyHat (hat definitions)
 * - listHatAssignments / assignHat / unassignHat (hat attribution)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
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

// ---- helpers ----------------------------------------------------------------

interface MockChild {
  name: string
  attrs?: Record<string, string>
  children?: MockChild[]
  text?: () => string
  getChildren?: (name: string) => MockChild[]
  getChild?: (name: string, xmlns?: string) => MockChild | undefined
  getChildText?: (name: string) => string | null
}

function mockEl(
  name: string,
  attrs: Record<string, string> = {},
  children: MockChild[] = [],
): MockChild {
  const el: MockChild = {
    name,
    attrs,
    children,
    getChildren: (childName: string) =>
      children.filter(c => c.name === childName),
    getChild: (childName: string, xmlns?: string) =>
      children.find(c => {
        if (c.name !== childName) return false
        if (xmlns && c.attrs?.xmlns !== xmlns) return false
        return true
      }),
    getChildText: (childName: string) => {
      const child = children.find(c => c.name === childName)
      return child?.text?.() ?? null
    },
    text: () => '',
  }
  return el
}

/** Build a `<field var="..."><value>text</value></field>` mock */
function fieldEl(varName: string, value: string): MockChild {
  const valueChild: MockChild = {
    name: 'value',
    attrs: {},
    children: [],
    text: () => value,
    getChildren: () => [],
    getChild: () => undefined,
    getChildText: () => null,
  }
  return mockEl('field', { var: varName }, [valueChild])
}

/** Wrap field elements in `<item>` (data form result row) */
function itemEl(fields: MockChild[]): MockChild {
  return mockEl('item', {}, fields)
}

/**
 * Build a full IQ response for a hat list/list-assigned command.
 * Wraps items in `<command><x type="result">...</x></command>`.
 */
function hatListResponse(items: MockChild[]): MockChild {
  const dataForm = mockEl('x', { xmlns: 'jabber:x:data', type: 'result' }, items)
  const command = mockEl('command', { xmlns: 'http://jabber.org/protocol/commands', status: 'completed' }, [dataForm])
  return mockEl('iq', { type: 'result' }, [command])
}

/** Build an empty successful IQ result (for create/destroy/assign/unassign) */
function emptyResultResponse(): MockChild {
  return mockEl('iq', { type: 'result' }, [
    mockEl('command', { xmlns: 'http://jabber.org/protocol/commands', status: 'completed' }),
  ])
}

// ---- setup ------------------------------------------------------------------

describe('MUC Hat Management (XEP-0317)', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as unknown as ReturnType<typeof xmppClientFactory>)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function connectClient() {
    const p = xmppClient.connect({
      jid: 'owner@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await p
    vi.clearAllMocks()
  }

  // ---------- listHats -------------------------------------------------------

  describe('listHats', () => {
    it('should send ad-hoc command with correct node', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(hatListResponse([]))

      await xmppClient.muc.listHats('room@conference.example.com')

      const sentIq = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      expect(sentIq.attrs.to).toBe('room@conference.example.com')
      expect(sentIq.attrs.type).toBe('set')

      const command = sentIq.children[0]
      expect(command.name).toBe('command')
      expect(command.attrs.xmlns).toBe('http://jabber.org/protocol/commands')
      expect(command.attrs.node).toBe('urn:xmpp:hats:commands:list')
      expect(command.attrs.action).toBe('execute')
    })

    it('should parse hat definitions from response', async () => {
      await connectClient()

      const response = hatListResponse([
        itemEl([
          fieldEl('hats#uri', 'http://example.com/hats#moderator'),
          fieldEl('hats#title', 'Moderator'),
          fieldEl('hats#hue', '210'),
        ]),
        itemEl([
          fieldEl('hats#uri', 'http://example.com/hats#speaker'),
          fieldEl('hats#title', 'Speaker'),
        ]),
      ])
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(response)

      const hats = await xmppClient.muc.listHats('room@conference.example.com')

      expect(hats).toHaveLength(2)
      expect(hats[0]).toEqual({ uri: 'http://example.com/hats#moderator', title: 'Moderator', hue: 210 })
      expect(hats[1]).toEqual({ uri: 'http://example.com/hats#speaker', title: 'Speaker', hue: undefined })
    })

    it('should return empty array when no hats defined', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(hatListResponse([]))

      const hats = await xmppClient.muc.listHats('room@conference.example.com')
      expect(hats).toEqual([])
    })

    it('should skip items missing required fields', async () => {
      await connectClient()

      const response = hatListResponse([
        itemEl([fieldEl('hats#uri', 'http://example.com/hats#valid'), fieldEl('hats#title', 'Valid')]),
        itemEl([fieldEl('hats#uri', 'http://example.com/hats#no-title')]), // missing title
        itemEl([fieldEl('hats#title', 'No URI')]), // missing uri
      ])
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(response)

      const hats = await xmppClient.muc.listHats('room@conference.example.com')
      expect(hats).toHaveLength(1)
      expect(hats[0].title).toBe('Valid')
    })
  })

  // ---------- createHat ------------------------------------------------------

  describe('createHat', () => {
    it('should send ad-hoc command with title, uri, and hue fields', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResultResponse())

      await xmppClient.muc.createHat('room@conference.example.com', 'Speaker', 'http://example.com/hats#speaker', 120)

      const sentIq = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      const command = sentIq.children[0]
      expect(command.attrs.node).toBe('urn:xmpp:hats:commands:create')

      // The command should contain a data form
      const dataForm = command.children[0]
      expect(dataForm.name).toBe('x')
      expect(dataForm.attrs.type).toBe('submit')

      // Verify fields are present (form built by buildDataFormSubmit)
      const fields = dataForm.children.filter((c: { name: string }) => c.name === 'field')
      const fieldVars = fields.map((f: { attrs: { var: string } }) => f.attrs.var)
      expect(fieldVars).toContain('FORM_TYPE')
      expect(fieldVars).toContain('hats#title')
      expect(fieldVars).toContain('hats#uri')
      expect(fieldVars).toContain('hats#hue')
    })

    it('should omit hue field when not provided', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResultResponse())

      await xmppClient.muc.createHat('room@conference.example.com', 'Guest', 'http://example.com/hats#guest')

      const sentIq = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      const command = sentIq.children[0]
      const dataForm = command.children[0]
      const fields = dataForm.children.filter((c: { name: string }) => c.name === 'field')
      const fieldVars = fields.map((f: { attrs: { var: string } }) => f.attrs.var)
      expect(fieldVars).not.toContain('hats#hue')
    })

    it('should throw on server error', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('forbidden'))

      await expect(
        xmppClient.muc.createHat('room@conference.example.com', 'X', 'urn:x')
      ).rejects.toThrow('forbidden')
    })
  })

  // ---------- destroyHat -----------------------------------------------------

  describe('destroyHat', () => {
    it('should send ad-hoc command with uri field', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResultResponse())

      await xmppClient.muc.destroyHat('room@conference.example.com', 'http://example.com/hats#old')

      const sentIq = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      const command = sentIq.children[0]
      expect(command.attrs.node).toBe('urn:xmpp:hats:commands:destroy')

      const dataForm = command.children[0]
      const fields = dataForm.children.filter((c: { name: string }) => c.name === 'field')
      const fieldVars = fields.map((f: { attrs: { var: string } }) => f.attrs.var)
      expect(fieldVars).toContain('hats#uri')
    })
  })

  // ---------- listHatAssignments ---------------------------------------------

  describe('listHatAssignments', () => {
    it('should send ad-hoc command with correct node', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(hatListResponse([]))

      await xmppClient.muc.listHatAssignments('room@conference.example.com')

      const sentIq = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      const command = sentIq.children[0]
      expect(command.attrs.node).toBe('urn:xmpp:hats:commands:list-assigned')
    })

    it('should parse assignments with jid, uri, title, hue', async () => {
      await connectClient()

      const response = hatListResponse([
        itemEl([
          fieldEl('hats#jid', 'alice@example.com'),
          fieldEl('hats#uri', 'http://example.com/hats#mod'),
          fieldEl('hats#title', 'Moderator'),
          fieldEl('hats#hue', '200'),
        ]),
        itemEl([
          fieldEl('hats#jid', 'bob@example.com'),
          fieldEl('hats#uri', 'http://example.com/hats#speaker'),
          fieldEl('hats#title', 'Speaker'),
        ]),
      ])
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(response)

      const assignments = await xmppClient.muc.listHatAssignments('room@conference.example.com')

      expect(assignments).toHaveLength(2)
      expect(assignments[0]).toEqual({
        jid: 'alice@example.com',
        uri: 'http://example.com/hats#mod',
        title: 'Moderator',
        hue: 200,
      })
      expect(assignments[1]).toEqual({
        jid: 'bob@example.com',
        uri: 'http://example.com/hats#speaker',
        title: 'Speaker',
        hue: undefined,
      })
    })

    it('should filter out entries without a jid', async () => {
      await connectClient()

      const response = hatListResponse([
        itemEl([
          fieldEl('hats#jid', 'alice@example.com'),
          fieldEl('hats#uri', 'urn:hat:1'),
          fieldEl('hats#title', 'Hat 1'),
        ]),
        itemEl([
          fieldEl('hats#uri', 'urn:hat:2'),
          fieldEl('hats#title', 'Hat 2'),
          // no jid — should be filtered out
        ]),
      ])
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(response)

      const assignments = await xmppClient.muc.listHatAssignments('room@conference.example.com')
      expect(assignments).toHaveLength(1)
      expect(assignments[0].jid).toBe('alice@example.com')
    })
  })

  // ---------- assignHat ------------------------------------------------------

  describe('assignHat', () => {
    it('should send ad-hoc command with jid and uri fields', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResultResponse())

      await xmppClient.muc.assignHat('room@conference.example.com', 'alice@example.com', 'urn:hat:mod')

      const sentIq = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      expect(sentIq.attrs.to).toBe('room@conference.example.com')

      const command = sentIq.children[0]
      expect(command.attrs.node).toBe('urn:xmpp:hats:commands:assign')

      const dataForm = command.children[0]
      const fields = dataForm.children.filter((c: { name: string }) => c.name === 'field')
      const fieldVars = fields.map((f: { attrs: { var: string } }) => f.attrs.var)
      expect(fieldVars).toContain('hats#jid')
      expect(fieldVars).toContain('hats#uri')
    })
  })

  // ---------- multi-step ad-hoc command handling ------------------------------

  describe('multi-step ad-hoc commands', () => {
    /**
     * Build an "executing" response that mimics a server returning a form
     * with different field names than the client originally sent.
     * This reproduces the real-world scenario where the server uses e.g. `hat`
     * (list-single with options) instead of `hats#uri`.
     */
    function executingResponse(sessionid: string, formFields: MockChild[]): MockChild {
      const dataForm = mockEl('x', { xmlns: 'jabber:x:data', type: 'form' }, formFields)
      const actions = mockEl('actions', { execute: 'complete' }, [
        mockEl('complete', {}),
      ])
      const command = mockEl('command', {
        xmlns: 'http://jabber.org/protocol/commands',
        status: 'executing',
        sessionid,
        node: 'urn:xmpp:hats:commands:assign',
      }, [actions, dataForm])
      return mockEl('iq', { type: 'result' }, [command])
    }

    /** Build a field with options (list-single) */
    function listField(varName: string, label: string, options: Array<{ label: string; value: string }>): MockChild {
      const optionChildren = options.map(opt => {
        const valueChild: MockChild = {
          name: 'value',
          attrs: {},
          children: [],
          text: () => opt.value,
          getChildren: () => [],
          getChild: () => undefined,
          getChildText: () => null,
        }
        return mockEl('option', { label: opt.label }, [valueChild])
      })
      const field = mockEl('field', { var: varName, type: 'list-single', label }, optionChildren)
      return field
    }

    /** Build a jid-single field with a required child */
    function jidField(varName: string, label: string): MockChild {
      const required = mockEl('required', {})
      return mockEl('field', { var: varName, type: 'jid-single', label }, [required])
    }

    it('should map original field values to server form fields when names differ', async () => {
      await connectClient()

      // First call returns "executing" with a form using field `hat` (list-single)
      // instead of the `hats#uri` that the client originally sent
      const serverForm = executingResponse('session-123', [
        jidField('hats#jid', 'Jabber ID'),
        listField('hat', 'The role', [
          { label: 'Dev Team', value: 'xmpp:process-one:devteam' },
          { label: 'Support', value: 'xmpp:process-one:support' },
        ]),
      ])

      // Second call (completion) should succeed
      const completedResponse = emptyResultResponse()

      mockXmppClientInstance.iqCaller.request
        .mockResolvedValueOnce(serverForm)
        .mockResolvedValueOnce(completedResponse)

      await xmppClient.muc.assignHat(
        'room@conference.example.com',
        'user@example.com',
        'xmpp:process-one:devteam',
      )

      // Verify the completion IQ was sent
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(2)

      const completeIq = mockXmppClientInstance.iqCaller.request.mock.calls[1][0]
      const command = completeIq.children[0]
      expect(command.attrs.action).toBe('complete')
      expect(command.attrs.sessionid).toBe('session-123')

      // Verify the completion form uses the server's field names
      const dataForm = command.children[0]
      const fields = dataForm.children.filter((c: { name: string }) => c.name === 'field')
      const fieldMap = new Map(
        fields.map((f: { attrs: { var: string }; children: Array<{ children: unknown[] }> }) => {
          const value = f.children[0]?.children?.[0]
          return [f.attrs.var, value]
        })
      )

      // `hats#jid` should be present (exact match)
      expect(fieldMap.has('hats#jid')).toBe(true)
      expect(fieldMap.get('hats#jid')).toBe('user@example.com')

      // `hat` should be used (server's field name), NOT `hats#uri`
      expect(fieldMap.has('hat')).toBe(true)
      expect(fieldMap.get('hat')).toBe('xmpp:process-one:devteam')

      // `hats#uri` should NOT be present (server didn't use this field name)
      expect(fieldMap.has('hats#uri')).toBe(false)
    })
  })

  // ---------- unassignHat ----------------------------------------------------

  describe('unassignHat', () => {
    it('should send ad-hoc command with jid and uri fields', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResultResponse())

      await xmppClient.muc.unassignHat('room@conference.example.com', 'bob@example.com', 'urn:hat:mod')

      const sentIq = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      const command = sentIq.children[0]
      expect(command.attrs.node).toBe('urn:xmpp:hats:commands:unassign')

      const dataForm = command.children[0]
      const fields = dataForm.children.filter((c: { name: string }) => c.name === 'field')
      const fieldVars = fields.map((f: { attrs: { var: string } }) => f.attrs.var)
      expect(fieldVars).toContain('hats#jid')
      expect(fieldVars).toContain('hats#uri')
    })

    it('should throw on server rejection', async () => {
      await connectClient()
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('not-allowed'))

      await expect(
        xmppClient.muc.unassignHat('room@conference.example.com', 'bob@example.com', 'urn:hat:mod')
      ).rejects.toThrow('not-allowed')
    })
  })
})
