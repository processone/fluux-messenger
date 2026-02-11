/**
 * XMPPClient Admin Tests
 *
 * Tests for XEP-0133 Service Administration:
 * - Admin command discovery
 * - Command execution
 * - Data form parsing
 * - Multi-step command flows
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

// Mock @xmpp/client module
vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

// Mock @xmpp/debug
vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

// Import after mocking
import { client as xmppClientFactory } from '@xmpp/client'

// Helper to create admin-specific mock elements with proper getChildren support
interface AdminMockChild {
  name: string
  attrs?: Record<string, string>
  children?: unknown[]
  text?: () => string
  getChildren?: (name: string) => AdminMockChild[]
  getChild?: (name: string, xmlns?: string) => AdminMockChild | undefined
}

function createAdminMockElement(
  name: string,
  attrs: Record<string, string> = {},
  children: AdminMockChild[] = []
) {
  const element: any = {
    name,
    attrs,
    children,
    getChildren: (childName: string) => children.filter((c: any) => c.name === childName),
    getChild: (childName: string, xmlns?: string) => {
      return children.find((c: any) => {
        if (c.name !== childName) return false
        if (xmlns && c.attrs?.xmlns !== xmlns) return false
        return true
      })
    },
    text: () => '',
  }
  return element
}

describe('XMPPClient Admin', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function connectClient() {
    const connectPromise = xmppClient.connect({
      jid: 'admin@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.clearAllMocks()
  }

  describe('discoverAdminCommands', () => {
    it('should set isDiscovering to true during discovery', async () => {
      await connectClient()

      // Mock the iqCaller to not resolve immediately
      mockXmppClientInstance.iqCaller.request.mockReturnValue(
        new Promise(() => { /* never resolves */ })
      )

      xmppClient.admin.discoverAdminCommands()

      expect(emitSDKSpy).toHaveBeenCalledWith('admin:discovering', { isDiscovering: true })
    })

    it('should discover admin commands from disco#items', async () => {
      await connectClient()

      // Create items array with proper attrs
      const items = [
        { name: 'item', attrs: { jid: 'example.com', node: 'http://jabber.org/protocol/admin#add-user', name: 'Add User' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'http://jabber.org/protocol/admin#delete-user', name: 'Delete User' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'http://jabber.org/protocol/admin#get-online-users-num', name: 'Get Online Users Count' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'http://jabber.org/protocol/admin#announce', name: 'Send Announcement' } },
        // Non-admin command should be ignored
        { name: 'item', attrs: { jid: 'example.com', node: 'some-other-command', name: 'Other Command' } },
      ]

      // Mock disco#items response - iqCaller returns IQ result, which has getChild
      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      // Should set isAdmin to true since we found admin commands
      expect(emitSDKSpy).toHaveBeenCalledWith('admin:is-admin', { isAdmin: true })

      // Should set commands (filtering only admin commands)
      expect(emitSDKSpy).toHaveBeenCalledWith('admin:commands', expect.objectContaining({ commands: expect.any(Array) }))
      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      expect(commands).toHaveLength(4)

      // Check categorization
      const userCommands = commands.filter(c => c.category === 'user')
      expect(userCommands).toHaveLength(2)
      expect(userCommands.map(c => c.name)).toContain('Add User')
      expect(userCommands.map(c => c.name)).toContain('Delete User')

      const statsCommands = commands.filter(c => c.category === 'stats')
      expect(statsCommands).toHaveLength(1)
      expect(statsCommands[0].name).toBe('Get Online Users Count')

      const announcementCommands = commands.filter(c => c.category === 'announcement')
      expect(announcementCommands).toHaveLength(1)
      expect(announcementCommands[0].name).toBe('Send Announcement')
    })

    it('should set isAdmin to false when no admin commands found', async () => {
      await connectClient()

      // Mock empty disco#items response
      const discoItemsResponse = createAdminMockElement('query', {
        xmlns: 'http://jabber.org/protocol/disco#items',
      }, [])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      expect(emitSDKSpy).toHaveBeenCalledWith('admin:is-admin', { isAdmin: false })
      expect(emitSDKSpy).toHaveBeenCalledWith('admin:commands', { commands: [] })
    })

    it('should handle discovery error gracefully', async () => {
      await connectClient()

      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('forbidden'))

      await xmppClient.admin.discoverAdminCommands()

      expect(emitSDKSpy).toHaveBeenCalledWith('admin:is-admin', { isAdmin: false })
      expect(emitSDKSpy).toHaveBeenCalledWith('admin:discovering', { isDiscovering: false })
    })

    it('should set isDiscovering to false after discovery completes', async () => {
      await connectClient()

      const discoItemsResponse = createAdminMockElement('query', {
        xmlns: 'http://jabber.org/protocol/disco#items',
      }, [])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      // Find the last call to admin:discovering
      const discoveringCalls = emitSDKSpy.mock.calls.filter((call: unknown[]) => call[0] === 'admin:discovering')
      expect(discoveringCalls[discoveringCalls.length - 1]).toEqual(['admin:discovering', { isDiscovering: false }])
    })
  })

  describe('executeAdminCommand', () => {
    it('should set isExecuting to true during execution', async () => {
      await connectClient()

      // Mock the iqCaller to not resolve immediately
      mockXmppClientInstance.iqCaller.request.mockReturnValue(
        new Promise(() => { /* never resolves */ })
      )

      xmppClient.admin.executeAdminCommand('http://jabber.org/protocol/admin#add-user', 'execute')

      expect(emitSDKSpy).toHaveBeenCalledWith('admin:executing', { isExecuting: true })
    })

    it('should handle execution error and reset isExecuting', async () => {
      await connectClient()

      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('forbidden'))

      await expect(
        xmppClient.admin.executeAdminCommand('test-node', 'execute')
      ).rejects.toThrow('forbidden')

      // Find the last call to admin:executing
      const executingCalls = emitSDKSpy.mock.calls.filter((call: unknown[]) => call[0] === 'admin:executing')
      expect(executingCalls[executingCalls.length - 1]).toEqual(['admin:executing', { isExecuting: false }])
    })
  })

  describe('cancelAdminCommand', () => {
    it('should send cancel command and clear session', async () => {
      await connectClient()

      // Setup mock getCurrentSession to return active session
      vi.mocked(mockStores.admin.getCurrentSession).mockReturnValue({
        sessionId: 'session-123',
        node: 'http://jabber.org/protocol/admin#add-user',
        status: 'executing',
      })

      const commandResponse = createAdminMockElement('command', {
        xmlns: 'http://jabber.org/protocol/commands',
        sessionid: 'session-123',
        status: 'canceled',
        node: 'http://jabber.org/protocol/admin#add-user',
      }, [])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(commandResponse)

      await xmppClient.admin.cancelAdminCommand()

      expect(emitSDKSpy).toHaveBeenCalledWith('admin:session', { session: null })
    })

    it('should clear session even without active session', async () => {
      await connectClient()

      vi.mocked(mockStores.admin.getCurrentSession).mockReturnValue(null)

      await xmppClient.admin.cancelAdminCommand()

      expect(emitSDKSpy).toHaveBeenCalledWith('admin:session', { session: null })
    })
  })

  describe('command categorization', () => {
    it('should categorize user management commands correctly', async () => {
      await connectClient()

      const items = [
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#add-user', name: 'Add User' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#delete-user', name: 'Delete User' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#disable-user', name: 'Disable User' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#reenable-user', name: 'Re-enable User' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#end-user-session', name: 'End Session' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#change-user-password', name: 'Change Password' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#get-user-roster', name: 'Get Roster' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#get-user-lastlogin', name: 'Get Last Login' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#user-stats', name: 'User Stats' } },
      ]

      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      // change-user-password is filtered out (redundant with user-specific UI)
      expect(commands).toHaveLength(8)
      expect(commands.every(c => c.category === 'user')).toBe(true)
      expect(commands.find(c => c.node.includes('change-user-password'))).toBeUndefined()
    })

    it('should categorize server stats commands correctly', async () => {
      await connectClient()

      const items = [
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#get-online-users-num', name: 'Online Users Count' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#get-registered-users-num', name: 'Registered Users Count' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#num-active-users', name: 'Active Users Count' } },
      ]

      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      expect(commands).toHaveLength(3)
      expect(commands.every(c => c.category === 'stats')).toBe(true)
    })

    it('should categorize announcement commands correctly', async () => {
      await connectClient()

      const items = [
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#announce', name: 'Announce' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#set-motd', name: 'Set MOTD' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#edit-motd', name: 'Edit MOTD' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#delete-motd', name: 'Delete MOTD' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#set-welcome', name: 'Set Welcome' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#delete-welcome', name: 'Delete Welcome' } },
      ]

      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      expect(commands).toHaveLength(6)
      expect(commands.every(c => c.category === 'announcement')).toBe(true)
    })

    it('should discover ejabberd api-commands alongside standard admin commands', async () => {
      await connectClient()

      const items = [
        // Standard XEP-0133 admin commands
        { name: 'item', attrs: { jid: 'example.com', node: 'http://jabber.org/protocol/admin#add-user', name: 'Add User' } },
        // ejabberd API commands
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/ban_account', name: 'ban_account' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/registered_users', name: 'registered_users' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/status', name: 'status' } },
        // Non-admin command should be ignored
        { name: 'item', attrs: { jid: 'example.com', node: 'some-other-command', name: 'Other' } },
      ]

      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      expect(emitSDKSpy).toHaveBeenCalledWith('admin:is-admin', { isAdmin: true })

      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      // Should include standard + api-commands, but not the other command
      expect(commands).toHaveLength(4)
      expect(commands.map(c => c.node)).toContain('http://jabber.org/protocol/admin#add-user')
      expect(commands.map(c => c.node)).toContain('api-commands/ban_account')
      expect(commands.map(c => c.node)).toContain('api-commands/registered_users')
      expect(commands.map(c => c.node)).toContain('api-commands/status')
    })

    it('should categorize ejabberd api-commands user commands correctly', async () => {
      await connectClient()

      const items = [
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/ban_account', name: 'ban_account' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/unban_account', name: 'unban_account' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/registered_users', name: 'registered_users' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/register', name: 'register' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/unregister', name: 'unregister' } },
      ]

      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      expect(commands.every(c => c.category === 'user')).toBe(true)
    })

    it('should categorize ejabberd api-commands announcement commands correctly', async () => {
      await connectClient()

      const items = [
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/send_message', name: 'send_message' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/send_stanza', name: 'send_stanza' } },
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/send_stanza_c2s', name: 'send_stanza_c2s' } },
      ]

      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      expect(commands.every(c => c.category === 'announcement')).toBe(true)
    })

    it('should extract command name correctly from api-commands/ node', async () => {
      await connectClient()

      const items = [
        { name: 'item', attrs: { jid: 'example.com', node: 'api-commands/get_roster', name: 'get_roster' } },
      ]

      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      expect(commands[0].name).toBe('get_roster')
      expect(commands[0].node).toBe('api-commands/get_roster')
    })

    it('should filter out redundant commands like change-user-password', async () => {
      await connectClient()

      const items = [
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#add-user', name: 'Add User' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#change-user-password', name: 'Change Password' } },
        { name: 'item', attrs: { node: 'api-commands/change_password', name: 'change_password' } },
        { name: 'item', attrs: { node: 'http://jabber.org/protocol/admin#delete-user', name: 'Delete User' } },
      ]

      const discoItemsResponse = {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return {
              name: 'query',
              attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
              getChildren: (childName: string) => childName === 'item' ? items : [],
            }
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(discoItemsResponse)

      await xmppClient.admin.discoverAdminCommands()

      const commandsCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'admin:commands')
      const commands = (commandsCall![1] as { commands: any[] }).commands
      // Both change-user-password (XEP-0133) and change_password (api-commands) should be filtered
      expect(commands).toHaveLength(2)
      expect(commands.map(c => c.name)).toEqual(['Add User', 'Delete User'])
    })
  })

  describe('fetchUserList', () => {
    // Helper to wrap a command element in an IQ response
    function wrapInIqResponse(commandEl: ReturnType<typeof createAdminMockElement>) {
      return {
        name: 'iq',
        attrs: { type: 'result' },
        getChild: (name: string, xmlns?: string) => {
          if (name === 'command' && xmlns === 'http://jabber.org/protocol/commands') {
            return commandEl
          }
          return undefined
        },
      }
    }

    it('should handle two-step ad-hoc command flow', async () => {
      await connectClient()

      // Step 1: Execute returns a form (status='executing')
      const executeCommand = createAdminMockElement('command', {
        xmlns: 'http://jabber.org/protocol/commands',
        sessionid: 'session-abc',
        status: 'executing',
        node: 'http://jabber.org/protocol/admin#get-registered-users-list',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:data', type: 'form' },
          getChildren: () => [],
          getChild: () => undefined,
        },
      ])

      // Step 2: Complete returns the user list (status='completed')
      const completeCommand = createAdminMockElement('command', {
        xmlns: 'http://jabber.org/protocol/commands',
        sessionid: 'session-abc',
        status: 'completed',
        node: 'http://jabber.org/protocol/admin#get-registered-users-list',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:data', type: 'result' },
          getChildren: (name: string) => {
            if (name === 'field') {
              return [{
                name: 'field',
                attrs: { var: 'accountjids' },
                getChild: () => undefined, // No 'required' child
                getChildren: (n: string) => n === 'value' ? [
                  { name: 'value', text: () => 'alice@example.com' },
                  { name: 'value', text: () => 'bob@example.com' },
                  { name: 'value', text: () => 'carol@example.com' },
                ] : [],
              }]
            }
            return []
          },
          getChild: () => undefined,
        },
      ])

      // Mock sequential responses (wrapped in IQ)
      mockXmppClientInstance.iqCaller.request
        .mockResolvedValueOnce(wrapInIqResponse(executeCommand))
        .mockResolvedValueOnce(wrapInIqResponse(completeCommand))

      const result = await xmppClient.admin.fetchUserList()

      // Should have made two requests (execute + complete)
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(2)

      // Should return parsed users
      expect(result.users).toHaveLength(3)
      expect(result.users[0].jid).toBe('alice@example.com')
      expect(result.users[0].username).toBe('alice')
      expect(result.users[1].jid).toBe('bob@example.com')
      expect(result.users[2].jid).toBe('carol@example.com')
    })

    it('should handle single-step response when server returns users immediately', async () => {
      await connectClient()

      // Some servers might return users directly on execute (status='completed')
      const directCommand = createAdminMockElement('command', {
        xmlns: 'http://jabber.org/protocol/commands',
        status: 'completed',
        node: 'http://jabber.org/protocol/admin#get-registered-users-list',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:data', type: 'result' },
          getChildren: (name: string) => {
            if (name === 'field') {
              return [{
                name: 'field',
                attrs: { var: 'accountjids' },
                getChild: () => undefined,
                getChildren: (n: string) => n === 'value' ? [
                  { name: 'value', text: () => 'user1@example.com' },
                ] : [],
              }]
            }
            return []
          },
          getChild: () => undefined,
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(wrapInIqResponse(directCommand))

      const result = await xmppClient.admin.fetchUserList()

      // Should have made only one request
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(1)

      expect(result.users).toHaveLength(1)
      expect(result.users[0].jid).toBe('user1@example.com')
    })

    it('should handle ejabberd registereduserjids field name', async () => {
      await connectClient()

      // ejabberd uses 'registereduserjids' instead of 'accountjids'
      const ejabberdCommand = createAdminMockElement('command', {
        xmlns: 'http://jabber.org/protocol/commands',
        status: 'completed',
        node: 'http://jabber.org/protocol/admin#get-registered-users-list',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:data', type: 'result' },
          getChildren: (name: string) => {
            if (name === 'field') {
              return [{
                name: 'field',
                attrs: { var: 'registereduserjids' },
                getChild: () => undefined,
                getChildren: (n: string) => n === 'value' ? [
                  { name: 'value', text: () => 'alice@ejabberd.example' },
                  { name: 'value', text: () => 'bob@ejabberd.example' },
                ] : [],
              }]
            }
            return []
          },
          getChild: () => undefined,
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(wrapInIqResponse(ejabberdCommand))

      const result = await xmppClient.admin.fetchUserList()

      expect(result.users).toHaveLength(2)
      expect(result.users[0].jid).toBe('alice@ejabberd.example')
      expect(result.users[1].jid).toBe('bob@ejabberd.example')
    })

    it('should return empty list when no users found', async () => {
      await connectClient()

      const emptyCommand = createAdminMockElement('command', {
        xmlns: 'http://jabber.org/protocol/commands',
        status: 'completed',
        node: 'http://jabber.org/protocol/admin#get-registered-users-list',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'jabber:x:data', type: 'result' },
          getChildren: () => [],
          getChild: () => undefined,
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(wrapInIqResponse(emptyCommand))

      const result = await xmppClient.admin.fetchUserList()

      expect(result.users).toHaveLength(0)
      expect(result.pagination).toEqual({})
    })

    it('should throw error when not connected', async () => {
      // Don't connect

      await expect(xmppClient.admin.fetchUserList()).rejects.toThrow('Not connected')
    })

    it('should throw error when response has no command element', async () => {
      await connectClient()

      const invalidResponse = createAdminMockElement('iq', { type: 'result' }, [])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(invalidResponse)

      await expect(xmppClient.admin.fetchUserList()).rejects.toThrow('Invalid response: no command element')
    })
  })

  describe('fetchRoomList', () => {
    it('should use provided MUC service JID', async () => {
      await connectClient()

      const mockQuery = createAdminMockElement('query', {
        xmlns: 'http://jabber.org/protocol/disco#items',
      }, [
        { name: 'item', attrs: { jid: 'room1@conference.example.com', name: 'Room 1' }, getChildren: () => [] },
        { name: 'item', attrs: { jid: 'room2@conference.example.com', name: 'Room 2' }, getChildren: () => [] },
      ])

      const mockResponse = {
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return mockQuery
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(mockResponse)

      const result = await xmppClient.admin.fetchRoomList('custom.muc.server.com')

      // Verify custom MUC service was used in the request
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledWith(
        expect.objectContaining({
          attrs: expect.objectContaining({
            to: 'custom.muc.server.com',
          }),
        })
      )

      expect(result.rooms).toHaveLength(2)
      expect(result.rooms[0].jid).toBe('room1@conference.example.com')
      expect(result.rooms[0].name).toBe('Room 1')
    })

    it('should auto-discover MUC service when not provided', async () => {
      await connectClient()

      // Mock getMucServiceJid to return a cached value
      ;(mockStores.admin as any).getMucServiceJid = vi.fn().mockReturnValue('conference.example.com')

      const mockQuery = createAdminMockElement('query', {
        xmlns: 'http://jabber.org/protocol/disco#items',
      }, [
        { name: 'item', attrs: { jid: 'room@conference.example.com', name: 'Test Room' }, getChildren: () => [] },
      ])

      const mockResponse = {
        getChild: (name: string, xmlns?: string) => {
          if (name === 'query' && xmlns === 'http://jabber.org/protocol/disco#items') {
            return mockQuery
          }
          return undefined
        },
      }

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(mockResponse)

      const result = await xmppClient.admin.fetchRoomList()

      // Verify auto-discovered MUC service was used
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledWith(
        expect.objectContaining({
          attrs: expect.objectContaining({
            to: 'conference.example.com',
          }),
        })
      )

      expect(result.rooms).toHaveLength(1)
    })

    it('should throw error when not connected', async () => {
      await expect(xmppClient.admin.fetchRoomList('muc.example.com')).rejects.toThrow('Not connected')
    })

    it('should throw error when MUC service not available and not provided', async () => {
      await connectClient()

      // Mock no MUC service available
      ;(mockStores.admin as any).getMucServiceJid = vi.fn().mockReturnValue(null)

      // Mock discoverMucService to also return null
      vi.spyOn(xmppClient.admin, 'discoverMucService').mockResolvedValue(null)

      await expect(xmppClient.admin.fetchRoomList()).rejects.toThrow('MUC service not available')
    })
  })
})
