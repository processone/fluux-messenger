import { describe, it, expect, beforeEach } from 'vitest'
import { adminStore } from './adminStore'
import type { AdminCommand, AdminSession, DataForm } from '../core/types'

describe('adminStore', () => {
  beforeEach(() => {
    adminStore.getState().reset()
  })

  describe('isAdmin state', () => {
    it('should start with isAdmin as false', () => {
      expect(adminStore.getState().isAdmin).toBe(false)
    })

    it('should set isAdmin to true', () => {
      adminStore.getState().setIsAdmin(true)
      expect(adminStore.getState().isAdmin).toBe(true)
    })

    it('should set isAdmin back to false', () => {
      adminStore.getState().setIsAdmin(true)
      adminStore.getState().setIsAdmin(false)
      expect(adminStore.getState().isAdmin).toBe(false)
    })
  })

  describe('commands', () => {
    it('should start with empty commands array', () => {
      expect(adminStore.getState().commands).toEqual([])
    })

    it('should set commands', () => {
      const commands: AdminCommand[] = [
        { node: 'http://jabber.org/protocol/admin#add-user', name: 'Add User', category: 'user' },
        { node: 'http://jabber.org/protocol/admin#get-online-users-num', name: 'Get Online Users', category: 'stats' },
      ]

      adminStore.getState().setCommands(commands)

      expect(adminStore.getState().commands).toHaveLength(2)
      expect(adminStore.getState().commands[0].name).toBe('Add User')
      expect(adminStore.getState().commands[1].category).toBe('stats')
    })

    it('should replace existing commands', () => {
      adminStore.getState().setCommands([
        { node: 'node1', name: 'Command 1', category: 'user' },
      ])
      adminStore.getState().setCommands([
        { node: 'node2', name: 'Command 2', category: 'stats' },
      ])

      expect(adminStore.getState().commands).toHaveLength(1)
      expect(adminStore.getState().commands[0].name).toBe('Command 2')
    })
  })

  describe('currentSession', () => {
    it('should start with null currentSession', () => {
      expect(adminStore.getState().currentSession).toBeNull()
    })

    it('should set currentSession', () => {
      const session: AdminSession = {
        sessionId: 'session-123',
        node: 'http://jabber.org/protocol/admin#add-user',
        status: 'executing',
        form: {
          type: 'form',
          title: 'Add User',
          fields: [
            { var: 'accountjid', type: 'jid-single', label: 'JID' },
            { var: 'password', type: 'text-private', label: 'Password' },
          ],
        },
      }

      adminStore.getState().setCurrentSession(session)

      const current = adminStore.getState().currentSession
      expect(current).not.toBeNull()
      expect(current!.sessionId).toBe('session-123')
      expect(current!.status).toBe('executing')
      expect(current!.form?.fields).toHaveLength(2)
    })

    it('should clear currentSession', () => {
      adminStore.getState().setCurrentSession({
        sessionId: 'session-123',
        node: 'test-node',
        status: 'executing',
      })
      adminStore.getState().setCurrentSession(null)

      expect(adminStore.getState().currentSession).toBeNull()
    })

    it('should update session with completed status', () => {
      adminStore.getState().setCurrentSession({
        sessionId: 'session-123',
        node: 'test-node',
        status: 'executing',
      })

      adminStore.getState().setCurrentSession({
        sessionId: 'session-123',
        node: 'test-node',
        status: 'completed',
        form: {
          type: 'result',
          fields: [{ var: 'result', type: 'fixed', value: 'User added successfully' }],
        },
      })

      expect(adminStore.getState().currentSession?.status).toBe('completed')
    })

    it('should store session with note', () => {
      const session: AdminSession = {
        sessionId: 'session-123',
        node: 'test-node',
        status: 'completed',
        note: {
          type: 'info',
          text: 'Operation completed successfully',
        },
      }

      adminStore.getState().setCurrentSession(session)

      expect(adminStore.getState().currentSession?.note?.type).toBe('info')
      expect(adminStore.getState().currentSession?.note?.text).toBe('Operation completed successfully')
    })

    it('should store session with actions', () => {
      const session: AdminSession = {
        sessionId: 'session-123',
        node: 'test-node',
        status: 'executing',
        actions: ['prev', 'next', 'complete'],
      }

      adminStore.getState().setCurrentSession(session)

      expect(adminStore.getState().currentSession?.actions).toContain('prev')
      expect(adminStore.getState().currentSession?.actions).toContain('next')
    })
  })

  describe('loading states', () => {
    it('should start with isDiscovering as false', () => {
      expect(adminStore.getState().isDiscovering).toBe(false)
    })

    it('should set isDiscovering', () => {
      adminStore.getState().setIsDiscovering(true)
      expect(adminStore.getState().isDiscovering).toBe(true)

      adminStore.getState().setIsDiscovering(false)
      expect(adminStore.getState().isDiscovering).toBe(false)
    })

    it('should start with isExecuting as false', () => {
      expect(adminStore.getState().isExecuting).toBe(false)
    })

    it('should set isExecuting', () => {
      adminStore.getState().setIsExecuting(true)
      expect(adminStore.getState().isExecuting).toBe(true)

      adminStore.getState().setIsExecuting(false)
      expect(adminStore.getState().isExecuting).toBe(false)
    })
  })

  describe('reset', () => {
    it('should reset all state to initial values', () => {
      // Set various state
      adminStore.getState().setIsAdmin(true)
      adminStore.getState().setCommands([
        { node: 'test', name: 'Test', category: 'user' },
      ])
      adminStore.getState().setCurrentSession({
        sessionId: 'session-123',
        node: 'test',
        status: 'executing',
      })
      adminStore.getState().setIsDiscovering(true)
      adminStore.getState().setIsExecuting(true)

      // Reset
      adminStore.getState().reset()

      // Verify all reset
      expect(adminStore.getState().isAdmin).toBe(false)
      expect(adminStore.getState().commands).toEqual([])
      expect(adminStore.getState().currentSession).toBeNull()
      expect(adminStore.getState().isDiscovering).toBe(false)
      expect(adminStore.getState().isExecuting).toBe(false)
    })
  })

  describe('form field types', () => {
    it('should handle all form field types', () => {
      const form: DataForm = {
        type: 'form',
        title: 'Test Form',
        instructions: ['Fill out the form'],
        fields: [
          { var: 'text', type: 'text-single', label: 'Text', required: true },
          { var: 'password', type: 'text-private', label: 'Password' },
          { var: 'multi', type: 'text-multi', label: 'Multi-line', value: ['line1', 'line2'] },
          { var: 'select', type: 'list-single', label: 'Select', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
          { var: 'multiselect', type: 'list-multi', label: 'Multi-select', value: ['a', 'b'] },
          { var: 'bool', type: 'boolean', label: 'Boolean', value: '1' },
          { var: 'jid', type: 'jid-single', label: 'JID' },
          { var: 'jids', type: 'jid-multi', label: 'JIDs' },
          { var: 'fixed', type: 'fixed', value: 'Read-only text' },
          { var: 'hidden', type: 'hidden', value: 'secret' },
        ],
      }

      const session: AdminSession = {
        sessionId: 'test',
        node: 'test',
        status: 'executing',
        form,
      }

      adminStore.getState().setCurrentSession(session)

      const stored = adminStore.getState().currentSession?.form
      expect(stored?.fields).toHaveLength(10)
      expect(stored?.fields.find(f => f.var === 'text')?.required).toBe(true)
      expect(stored?.fields.find(f => f.var === 'multi')?.value).toEqual(['line1', 'line2'])
      expect(stored?.fields.find(f => f.var === 'select')?.options).toHaveLength(2)
    })
  })

  describe('admin user-list extras', () => {
    beforeEach(() => adminStore.getState().reset())

    it('setLastActivity replaces the map reference (per-key subscribers re-render)', () => {
      const before = adminStore.getState().lastActivity
      adminStore.getState().setLastActivity('a@x.com', { state: 'loading', seconds: null })
      const after = adminStore.getState().lastActivity
      expect(after).not.toBe(before)
      expect(after.get('a@x.com')).toEqual({ state: 'loading', seconds: null })
    })

    it('setOnlineJids / setLastActivitySupported / setUsersTruncated store values', () => {
      adminStore.getState().setOnlineJids(new Set(['a@x.com']))
      adminStore.getState().setLastActivitySupported(false)
      adminStore.getState().setUsersTruncated(true)
      const s = adminStore.getState()
      expect(s.onlineJids.has('a@x.com')).toBe(true)
      expect(s.lastActivitySupported).toBe(false)
      expect(s.usersTruncated).toBe(true)
    })

    it('reset restores last-activity defaults', () => {
      adminStore.getState().setLastActivity('a@x.com', { state: 'loaded', seconds: 1 })
      adminStore.getState().setLastActivitySupported(false)
      adminStore.getState().setUsersTruncated(true)
      adminStore.getState().reset()
      const s = adminStore.getState()
      expect(s.lastActivity.size).toBe(0)
      expect(s.onlineJids.size).toBe(0)
      expect(s.lastActivitySupported).toBe(true)
      expect(s.usersTruncated).toBe(false)
    })
  })
})
