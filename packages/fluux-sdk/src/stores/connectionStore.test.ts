import { describe, it, expect, beforeEach } from 'vitest'
import { connectionStore } from './connectionStore'

describe('connectionStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    connectionStore.getState().reset()
  })

  describe('initial state', () => {
    it('should have disconnected status initially', () => {
      const state = connectionStore.getState()
      expect(state.status).toBe('disconnected')
      expect(state.jid).toBeNull()
      expect(state.error).toBeNull()
      expect(state.reconnectAttempt).toBe(0)
      expect(state.reconnectIn).toBeNull()
    })
  })

  describe('setStatus', () => {
    it('should update status', () => {
      connectionStore.getState().setStatus('online')
      expect(connectionStore.getState().status).toBe('online')

      connectionStore.getState().setStatus('reconnecting')
      expect(connectionStore.getState().status).toBe('reconnecting')

      connectionStore.getState().setStatus('error')
      expect(connectionStore.getState().status).toBe('error')
    })
  })

  describe('setJid', () => {
    it('should update jid', () => {
      connectionStore.getState().setJid('user@example.com')
      expect(connectionStore.getState().jid).toBe('user@example.com')

      connectionStore.getState().setJid(null)
      expect(connectionStore.getState().jid).toBeNull()
    })
  })

  describe('setError', () => {
    it('should update error', () => {
      connectionStore.getState().setError('Something went wrong')
      expect(connectionStore.getState().error).toBe('Something went wrong')

      connectionStore.getState().setError(null)
      expect(connectionStore.getState().error).toBeNull()
    })
  })

  describe('setReconnectState', () => {
    it('should update reconnect attempt and countdown', () => {
      connectionStore.getState().setReconnectState(3, 15)

      expect(connectionStore.getState().reconnectAttempt).toBe(3)
      expect(connectionStore.getState().reconnectIn).toBe(15)
    })

    it('should allow setting reconnectIn to null', () => {
      connectionStore.getState().setReconnectState(1, 10)
      connectionStore.getState().setReconnectState(1, null)

      expect(connectionStore.getState().reconnectAttempt).toBe(1)
      expect(connectionStore.getState().reconnectIn).toBeNull()
    })
  })


  describe('reset', () => {
    it('should reset all state to initial values', () => {
      // Set some state first
      connectionStore.setState({
        status: 'online',
        jid: 'user@example.com',
        error: 'some error',
        reconnectAttempt: 5,
        reconnectIn: 30,
      })

      connectionStore.getState().reset()

      const state = connectionStore.getState()
      expect(state.status).toBe('disconnected')
      expect(state.jid).toBeNull()
      expect(state.error).toBeNull()
      expect(state.reconnectAttempt).toBe(0)
      expect(state.reconnectIn).toBeNull()
    })

    it('should reset serverInfo to null', () => {
      connectionStore.setState({
        serverInfo: {
          domain: 'example.com',
          identities: [{ category: 'server', type: 'im', name: 'Test Server' }],
          features: ['http://jabber.org/protocol/disco#info'],
        },
      })

      connectionStore.getState().reset()

      expect(connectionStore.getState().serverInfo).toBeNull()
    })
  })

  describe('setServerInfo', () => {
    it('should have null serverInfo initially', () => {
      expect(connectionStore.getState().serverInfo).toBeNull()
    })

    it('should update serverInfo with server data', () => {
      const serverInfo = {
        domain: 'example.com',
        identities: [
          { category: 'server', type: 'im', name: 'ejabberd' },
        ],
        features: [
          'http://jabber.org/protocol/disco#info',
          'urn:xmpp:carbons:2',
          'urn:xmpp:mam:2',
        ],
      }

      connectionStore.getState().setServerInfo(serverInfo)

      const state = connectionStore.getState()
      expect(state.serverInfo).toEqual(serverInfo)
      expect(state.serverInfo?.domain).toBe('example.com')
      expect(state.serverInfo?.identities).toHaveLength(1)
      expect(state.serverInfo?.features).toHaveLength(3)
    })

    it('should allow clearing serverInfo by setting null', () => {
      connectionStore.getState().setServerInfo({
        domain: 'example.com',
        identities: [],
        features: ['some-feature'],
      })

      expect(connectionStore.getState().serverInfo).not.toBeNull()

      connectionStore.getState().setServerInfo(null)

      expect(connectionStore.getState().serverInfo).toBeNull()
    })

    it('should store multiple identities', () => {
      const serverInfo = {
        domain: 'example.com',
        identities: [
          { category: 'server', type: 'im', name: 'ejabberd' },
          { category: 'pubsub', type: 'pep' },
        ],
        features: [],
      }

      connectionStore.getState().setServerInfo(serverInfo)

      const state = connectionStore.getState()
      expect(state.serverInfo?.identities).toHaveLength(2)
      expect(state.serverInfo?.identities[0].name).toBe('ejabberd')
      expect(state.serverInfo?.identities[1].category).toBe('pubsub')
    })
  })

  describe('httpUploadService', () => {
    it('should have null httpUploadService initially', () => {
      expect(connectionStore.getState().httpUploadService).toBeNull()
    })

    it('should set httpUploadService with jid only', () => {
      connectionStore.getState().setHttpUploadService({
        jid: 'upload.example.com',
      })

      const state = connectionStore.getState()
      expect(state.httpUploadService).toEqual({
        jid: 'upload.example.com',
      })
      expect(state.httpUploadService?.jid).toBe('upload.example.com')
      expect(state.httpUploadService?.maxFileSize).toBeUndefined()
    })

    it('should set httpUploadService with jid and maxFileSize', () => {
      connectionStore.getState().setHttpUploadService({
        jid: 'upload.example.com',
        maxFileSize: 52428800, // 50 MB
      })

      const state = connectionStore.getState()
      expect(state.httpUploadService?.jid).toBe('upload.example.com')
      expect(state.httpUploadService?.maxFileSize).toBe(52428800)
    })

    it('should allow clearing httpUploadService by setting null', () => {
      connectionStore.getState().setHttpUploadService({
        jid: 'upload.example.com',
        maxFileSize: 10485760,
      })

      expect(connectionStore.getState().httpUploadService).not.toBeNull()

      connectionStore.getState().setHttpUploadService(null)

      expect(connectionStore.getState().httpUploadService).toBeNull()
    })

    it('should update httpUploadService when called again', () => {
      connectionStore.getState().setHttpUploadService({
        jid: 'upload1.example.com',
        maxFileSize: 10485760,
      })

      connectionStore.getState().setHttpUploadService({
        jid: 'upload2.example.com',
        maxFileSize: 104857600,
      })

      const state = connectionStore.getState()
      expect(state.httpUploadService?.jid).toBe('upload2.example.com')
      expect(state.httpUploadService?.maxFileSize).toBe(104857600)
    })

    it('should reset httpUploadService on store reset', () => {
      connectionStore.getState().setHttpUploadService({
        jid: 'upload.example.com',
        maxFileSize: 52428800,
      })

      expect(connectionStore.getState().httpUploadService).not.toBeNull()

      connectionStore.getState().reset()

      expect(connectionStore.getState().httpUploadService).toBeNull()
    })
  })

})
