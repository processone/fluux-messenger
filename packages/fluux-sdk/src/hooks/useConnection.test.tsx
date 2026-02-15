/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useConnection } from './useConnection'
import { connectionStore } from '../stores'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'

// Create shared mock client
const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return {
    ...actual,
    useXMPPContext: () => ({ client: mockClient }),
  }
})

// Wrapper component that provides XMPP context
function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

describe('useConnection hook', () => {
  beforeEach(() => {
    // Reset store state before each test
    connectionStore.getState().reset()
    vi.clearAllMocks()
  })

  describe('state reactivity', () => {
    it('should reflect status from store', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.status).toBe('disconnected')

      act(() => {
        connectionStore.getState().setStatus('connecting')
      })

      expect(result.current.status).toBe('connecting')

      act(() => {
        connectionStore.getState().setStatus('online')
      })

      expect(result.current.status).toBe('online')
    })

    it('should reflect jid from store', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.jid).toBeNull()

      act(() => {
        connectionStore.getState().setJid('user@example.com/resource')
      })

      expect(result.current.jid).toBe('user@example.com/resource')
    })

    it('should reflect error from store', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.error).toBeNull()

      act(() => {
        connectionStore.getState().setError('Connection refused')
      })

      expect(result.current.error).toBe('Connection refused')
    })

    it('should reflect reconnect state from store', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.reconnectAttempt).toBe(0)
      expect(result.current.reconnectTargetTime).toBeNull()

      act(() => {
        connectionStore.getState().setReconnectState(3, 5000)
      })

      expect(result.current.reconnectAttempt).toBe(3)
      expect(result.current.reconnectTargetTime).toBe(5000)
    })

    it('should reflect server info from store', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.serverInfo).toBeNull()

      const serverInfo = {
        domain: 'example.com',
        features: ['vcard-temp', 'muc'],
        identities: [],
      }

      act(() => {
        connectionStore.getState().setServerInfo(serverInfo)
      })

      expect(result.current.serverInfo?.domain).toBe('example.com')
      expect(result.current.serverInfo?.features).toContain('muc')
    })

    it('should reflect own profile state from store', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.ownAvatar).toBeNull()
      expect(result.current.ownNickname).toBeNull()

      act(() => {
        connectionStore.getState().setOwnAvatar('blob:avatar-url')
        connectionStore.getState().setOwnNickname('My Nickname')
      })

      expect(result.current.ownAvatar).toBe('blob:avatar-url')
      expect(result.current.ownNickname).toBe('My Nickname')
    })

    it('should reflect HTTP upload service from store', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.httpUploadService).toBeNull()

      act(() => {
        connectionStore.getState().setHttpUploadService({
          jid: 'upload.example.com',
          maxFileSize: 10485760,
        })
      })

      expect(result.current.httpUploadService?.jid).toBe('upload.example.com')
      expect(result.current.httpUploadService?.maxFileSize).toBe(10485760)
    })
  })

  describe('computed properties', () => {
    it('should compute isConnected correctly', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.isConnected).toBe(false)

      act(() => {
        connectionStore.getState().setStatus('online')
      })

      expect(result.current.isConnected).toBe(true)

      act(() => {
        connectionStore.getState().setStatus('disconnected')
      })

      expect(result.current.isConnected).toBe(false)
    })

    it('should compute isConnecting correctly', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.isConnecting).toBe(false)

      act(() => {
        connectionStore.getState().setStatus('connecting')
      })

      expect(result.current.isConnecting).toBe(true)

      act(() => {
        connectionStore.getState().setStatus('online')
      })

      expect(result.current.isConnecting).toBe(false)
    })

    it('should compute isReconnecting correctly', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.isReconnecting).toBe(false)

      act(() => {
        connectionStore.getState().setStatus('reconnecting')
      })

      expect(result.current.isReconnecting).toBe(true)
    })

    it('should compute supportsPasswordChange as false when serverInfo is null', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.supportsPasswordChange).toBe(false)
    })

    it('should compute supportsPasswordChange as true when server has jabber:iq:register feature', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      act(() => {
        connectionStore.getState().setServerInfo({
          domain: 'example.com',
          identities: [],
          features: ['jabber:iq:register', 'urn:xmpp:carbons:2'],
        })
      })

      expect(result.current.supportsPasswordChange).toBe(true)
    })

    it('should compute supportsPasswordChange as false when server lacks jabber:iq:register feature', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      act(() => {
        connectionStore.getState().setServerInfo({
          domain: 'example.com',
          identities: [],
          features: ['urn:xmpp:carbons:2', 'urn:xmpp:mam:2'],
        })
      })

      expect(result.current.supportsPasswordChange).toBe(false)
    })
  })

  describe('connect action', () => {
    it('should call client.connect and set status to connecting', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.connect.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.connect(
          'user@example.com',
          'password123',
          'wss://example.com/ws'
        )
      })

      expect(mockClient.connect).toHaveBeenCalledWith({
        jid: 'user@example.com',
        password: 'password123',
        server: 'wss://example.com/ws',
        resource: undefined,
        smState: undefined,
      })
    })

    it('should pass smState and resource to client.connect', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.connect.mockResolvedValue(undefined)

      const smState = { id: 'sm-session-1', inbound: 5 }

      await act(async () => {
        await result.current.connect(
          'user@example.com',
          'password123',
          'wss://example.com/ws',
          smState,
          'mobile'
        )
      })

      expect(mockClient.connect).toHaveBeenCalledWith({
        jid: 'user@example.com',
        password: 'password123',
        server: 'wss://example.com/ws',
        resource: 'mobile',
        smState,
      })
    })

    it('should set error status on connection failure', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.connect.mockRejectedValue(new Error('Authentication failed'))

      await act(async () => {
        await expect(
          result.current.connect(
            'user@example.com',
            'wrongpassword',
            'wss://example.com/ws'
          )
        ).rejects.toThrow('Authentication failed')
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error).toBe('Authentication failed')
    })
  })

  describe('disconnect action', () => {
    it('should call client.disconnect', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.disconnect.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.disconnect()
      })

      expect(mockClient.disconnect).toHaveBeenCalled()
    })
  })

  describe('cancelReconnect action', () => {
    it('should call client.cancelReconnect and reset state', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      // Set up reconnecting state
      act(() => {
        connectionStore.getState().setStatus('reconnecting')
        connectionStore.getState().setReconnectState(3, 5000)
      })

      act(() => {
        result.current.cancelReconnect()
      })

      expect(mockClient.cancelReconnect).toHaveBeenCalled()
      expect(result.current.status).toBe('disconnected')
      expect(result.current.reconnectAttempt).toBe(0)
      expect(result.current.reconnectTargetTime).toBeNull()
    })
  })


  describe('profile actions', () => {
    it('should call client.publishOwnNickname when setOwnNickname is called', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.profile.publishOwnNickname.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.setOwnNickname('My New Nickname')
      })

      expect(mockClient.profile.publishOwnNickname).toHaveBeenCalledWith('My New Nickname')
    })

    it('should call client.publishOwnAvatar when setOwnAvatar is called', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.profile.publishOwnAvatar.mockResolvedValue(undefined)

      const imageData = new Uint8Array([1, 2, 3, 4])

      await act(async () => {
        await result.current.setOwnAvatar(imageData, 'image/png', 100, 100)
      })

      // Hook converts Uint8Array to base64 data URL
      expect(mockClient.profile.publishOwnAvatar).toHaveBeenCalledWith(
        'data:image/png;base64,AQIDBA==',
        'image/png',
        100,
        100
      )
    })

    it('should call client.clearOwnAvatar when clearOwnAvatar is called', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.profile.clearOwnAvatar.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.clearOwnAvatar()
      })

      expect(mockClient.profile.clearOwnAvatar).toHaveBeenCalled()
    })

    it('should call client.clearOwnNickname when clearOwnNickname is called', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.profile.clearOwnNickname.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.clearOwnNickname()
      })

      expect(mockClient.profile.clearOwnNickname).toHaveBeenCalled()
    })
  })

  describe('stream management', () => {
    it('should call client.getStreamManagementState', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      const smState = { id: 'sm-session-1', inbound: 10 }
      mockClient.getStreamManagementState.mockReturnValue(smState)

      const state = result.current.getStreamManagementState()

      expect(mockClient.getStreamManagementState).toHaveBeenCalled()
      expect(state).toEqual(smState)
    })
  })

  describe('HTTP upload', () => {
    it('should call client.requestUploadSlot', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      const slot = {
        put: { url: 'https://upload.example.com/put/abc', headers: {} },
        get: 'https://upload.example.com/get/abc',
      }
      mockClient.discovery.requestUploadSlot.mockResolvedValue(slot)

      await act(async () => {
        const uploadSlot = await result.current.requestUploadSlot(
          'photo.jpg',
          1024,
          'image/jpeg'
        )
        expect(uploadSlot).toEqual(slot)
      })

      expect(mockClient.discovery.requestUploadSlot).toHaveBeenCalledWith('photo.jpg', 1024, 'image/jpeg')
    })
  })

  describe('link preview', () => {
    it('should call client.sendLinkPreview for chat', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.chat.sendLinkPreview.mockResolvedValue(undefined)

      const preview = {
        url: 'https://example.com/article',
        title: 'Example Article',
        description: 'An example article',
      }

      await act(async () => {
        await result.current.sendLinkPreview(
          'alice@example.com',
          'msg-123',
          preview,
          'chat'
        )
      })

      expect(mockClient.chat.sendLinkPreview).toHaveBeenCalledWith(
        'alice@example.com',
        'msg-123',
        preview,
        'chat'
      )
    })

    it('should call client.sendLinkPreview for groupchat', async () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      mockClient.chat.sendLinkPreview.mockResolvedValue(undefined)

      const preview = {
        url: 'https://example.com/article',
        title: 'Example Article',
      }

      await act(async () => {
        await result.current.sendLinkPreview(
          'room@conference.example.com',
          'msg-456',
          preview,
          'groupchat'
        )
      })

      expect(mockClient.chat.sendLinkPreview).toHaveBeenCalledWith(
        'room@conference.example.com',
        'msg-456',
        preview,
        'groupchat'
      )
    })
  })

  describe('own resources', () => {
    it('should reflect own resources from store', () => {
      const { result } = renderHook(() => useConnection(), { wrapper })

      expect(result.current.ownResources.size).toBe(0)

      act(() => {
        connectionStore.getState().updateOwnResource('desktop', null, 10, undefined, undefined, 'Fluux Desktop')
        connectionStore.getState().updateOwnResource('mobile', 'away', 5, undefined, undefined, 'Fluux Mobile')
      })

      expect(result.current.ownResources.size).toBe(2)
      expect(result.current.ownResources.get('desktop')?.client).toBe('Fluux Desktop')
      expect(result.current.ownResources.get('mobile')?.show).toBe('away')
    })
  })
})
