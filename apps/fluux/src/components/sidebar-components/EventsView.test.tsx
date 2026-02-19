import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EventsView } from './EventsView'

// Mock the Avatar component
vi.mock('../Avatar', () => ({
  Avatar: ({ name }: { name: string }) => (
    <div data-testid="avatar" data-name={name}>
      Avatar: {name}
    </div>
  ),
}))

// Mock functions
const mockBlockJid = vi.fn()
const mockRejectSubscription = vi.fn()
const mockIgnoreStranger = vi.fn()
const mockAcceptSubscription = vi.fn()
const mockAcceptStranger = vi.fn()
const mockAcceptInvitation = vi.fn()
const mockDeclineInvitation = vi.fn()
const mockDismissNotification = vi.fn()
const mockSetActiveConversation = vi.fn()
const mockSetActiveRoom = vi.fn()
const mockNavigate = vi.fn()

// Default mock state
let mockSubscriptionRequests: { id: string; from: string }[] = []
let mockStrangerConversations: Record<string, { id: string; from: string; body: string; timestamp: Date }[]> = {}
let mockMucInvitations: { id: string; roomJid: string; from: string; reason?: string; password?: string }[] = []
let mockSystemNotifications: { id: string; type: string; title: string; message: string }[] = []

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}))

// Mock the SDK hooks
vi.mock('@fluux/sdk', () => ({
  useEvents: () => ({
    subscriptionRequests: mockSubscriptionRequests,
    strangerConversations: mockStrangerConversations,
    mucInvitations: mockMucInvitations,
    systemNotifications: mockSystemNotifications,
    acceptSubscription: mockAcceptSubscription,
    rejectSubscription: mockRejectSubscription,
    acceptStranger: mockAcceptStranger,
    ignoreStranger: mockIgnoreStranger,
    acceptInvitation: mockAcceptInvitation,
    declineInvitation: mockDeclineInvitation,
    dismissNotification: mockDismissNotification,
  }),
  useBlocking: () => ({
    blockJid: mockBlockJid,
  }),
  getBareJid: (jid: string) => jid.split('/')[0],
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  // useChatStore is callable (hook-style) for selector subscriptions
  useChatStore: (selector: (state: { setActiveConversation: typeof mockSetActiveConversation }) => unknown) =>
    selector({ setActiveConversation: mockSetActiveConversation }),
  // useRoomStore is callable (hook-style) for selector subscriptions
  useRoomStore: (selector: (state: { setActiveRoom: typeof mockSetActiveRoom }) => unknown) =>
    selector({ setActiveRoom: mockSetActiveRoom }),
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('EventsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset mock state
    mockSubscriptionRequests = []
    mockStrangerConversations = {}
    mockMucInvitations = []
    mockSystemNotifications = []
  })

  describe('empty state', () => {
    it('should show no pending events message when there are no events', () => {
      render(<EventsView />)
      expect(screen.getByText('events.noPendingEvents')).toBeInTheDocument()
    })
  })

  describe('subscription requests', () => {
    beforeEach(() => {
      mockSubscriptionRequests = [
        { id: 'req1', from: 'alice@example.com' },
        { id: 'req2', from: 'bob@example.com' },
      ]
    })

    it('should render subscription requests with count', () => {
      render(<EventsView />)
      expect(screen.getByText(/events.subscriptionRequests/)).toBeInTheDocument()
      expect(screen.getByText('alice')).toBeInTheDocument()
      expect(screen.getByText('bob')).toBeInTheDocument()
    })

    it('should call acceptSubscription when Accept is clicked', async () => {
      render(<EventsView />)

      const acceptButtons = screen.getAllByText('common.accept')
      fireEvent.click(acceptButtons[0])

      expect(mockAcceptSubscription).toHaveBeenCalledWith('alice@example.com')
    })

    it('should call rejectSubscription when Reject is clicked', async () => {
      render(<EventsView />)

      const rejectButtons = screen.getAllByText('common.reject')
      fireEvent.click(rejectButtons[0])

      expect(mockRejectSubscription).toHaveBeenCalledWith('alice@example.com')
    })

    it('should reject and block when Block is clicked on subscription request', async () => {
      mockRejectSubscription.mockResolvedValue(undefined)
      mockBlockJid.mockResolvedValue(undefined)

      render(<EventsView />)

      // Find block buttons by aria-label
      const blockButtons = screen.getAllByLabelText('common.block')
      fireEvent.click(blockButtons[0])

      await waitFor(() => {
        expect(mockRejectSubscription).toHaveBeenCalledWith('alice@example.com')
        expect(mockBlockJid).toHaveBeenCalledWith('alice@example.com')
      })
    })

    it('should call blockJid after rejectSubscription completes', async () => {
      const callOrder: string[] = []
      mockRejectSubscription.mockImplementation(async () => {
        callOrder.push('reject')
      })
      mockBlockJid.mockImplementation(async () => {
        callOrder.push('block')
      })

      render(<EventsView />)

      const blockButtons = screen.getAllByLabelText('common.block')
      fireEvent.click(blockButtons[0])

      await waitFor(() => {
        expect(callOrder).toEqual(['reject', 'block'])
      })
    })
  })

  describe('stranger messages', () => {
    beforeEach(() => {
      mockStrangerConversations = {
        'stranger@example.com': [
          { id: 'msg1', from: 'stranger@example.com', body: 'Hello!', timestamp: new Date() },
        ],
        'spam@example.com': [
          { id: 'msg2', from: 'spam@example.com', body: 'Buy now!', timestamp: new Date() },
          { id: 'msg3', from: 'spam@example.com', body: 'Limited offer!', timestamp: new Date() },
        ],
      }
    })

    it('should render stranger messages with count', () => {
      render(<EventsView />)
      expect(screen.getByText(/events.messagesFromStrangers/)).toBeInTheDocument()
      expect(screen.getByText('stranger')).toBeInTheDocument()
      expect(screen.getByText('spam')).toBeInTheDocument()
    })

    it('should show message count badge for multiple messages', () => {
      render(<EventsView />)
      // spam@example.com has 2 messages
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    it('should call acceptStranger and navigate when Accept is clicked', async () => {
      mockAcceptStranger.mockResolvedValue(undefined)

      render(<EventsView />)

      const acceptButtons = screen.getAllByText('common.accept')
      fireEvent.click(acceptButtons[0])

      await waitFor(() => {
        expect(mockAcceptStranger).toHaveBeenCalledWith('stranger@example.com')
        expect(mockNavigate).toHaveBeenCalledWith('/messages/stranger%40example.com')
        expect(mockSetActiveConversation).toHaveBeenCalledWith('stranger@example.com')
      })
    })

    it('should call ignoreStranger when Ignore is clicked', async () => {
      render(<EventsView />)

      const ignoreButtons = screen.getAllByText('common.ignore')
      fireEvent.click(ignoreButtons[0])

      expect(mockIgnoreStranger).toHaveBeenCalledWith('stranger@example.com')
    })

    it('should ignore and block when Block is clicked on stranger message', async () => {
      mockIgnoreStranger.mockResolvedValue(undefined)
      mockBlockJid.mockResolvedValue(undefined)

      render(<EventsView />)

      // Find block buttons by aria-label
      const blockButtons = screen.getAllByLabelText('common.block')
      fireEvent.click(blockButtons[0])

      await waitFor(() => {
        expect(mockIgnoreStranger).toHaveBeenCalledWith('stranger@example.com')
        expect(mockBlockJid).toHaveBeenCalledWith('stranger@example.com')
      })
    })

    it('should call blockJid after ignoreStranger completes', async () => {
      const callOrder: string[] = []
      mockIgnoreStranger.mockImplementation(async () => {
        callOrder.push('ignore')
      })
      mockBlockJid.mockImplementation(async () => {
        callOrder.push('block')
      })

      render(<EventsView />)

      const blockButtons = screen.getAllByLabelText('common.block')
      fireEvent.click(blockButtons[0])

      await waitFor(() => {
        expect(callOrder).toEqual(['ignore', 'block'])
      })
    })
  })

  describe('MUC invitations', () => {
    beforeEach(() => {
      mockMucInvitations = [
        { id: 'inv1', roomJid: 'room@conference.example.com', from: 'friend@example.com', reason: 'Join us!' },
      ]
    })

    it('should render MUC invitations', () => {
      render(<EventsView />)
      expect(screen.getByText(/events.roomInvitations/)).toBeInTheDocument()
      expect(screen.getByText('room')).toBeInTheDocument()
    })

    it('should show invitation reason', () => {
      render(<EventsView />)
      expect(screen.getByText('"Join us!"')).toBeInTheDocument()
    })

    it('should call acceptInvitation and navigate when Join is clicked', async () => {
      mockAcceptInvitation.mockResolvedValue(undefined)

      render(<EventsView />)

      fireEvent.click(screen.getByText('events.join'))

      await waitFor(() => {
        expect(mockAcceptInvitation).toHaveBeenCalledWith('room@conference.example.com', undefined)
        expect(mockNavigate).toHaveBeenCalledWith('/rooms/room%40conference.example.com')
        expect(mockSetActiveRoom).toHaveBeenCalledWith('room@conference.example.com')
      })
    })

    it('should call declineInvitation when Decline is clicked', async () => {
      render(<EventsView />)

      fireEvent.click(screen.getByText('events.decline'))

      expect(mockDeclineInvitation).toHaveBeenCalledWith('room@conference.example.com')
    })

    it('should pass password to acceptInvitation when provided', async () => {
      mockMucInvitations = [
        { id: 'inv1', roomJid: 'private@conference.example.com', from: 'friend@example.com', password: 'secret123' },
      ]
      mockAcceptInvitation.mockResolvedValue(undefined)

      render(<EventsView />)

      fireEvent.click(screen.getByText('events.join'))

      await waitFor(() => {
        expect(mockAcceptInvitation).toHaveBeenCalledWith('private@conference.example.com', 'secret123')
      })
    })
  })

  describe('system notifications', () => {
    beforeEach(() => {
      mockSystemNotifications = [
        { id: 'notif1', type: 'resource-conflict', title: 'Session Conflict', message: 'Another device connected' },
      ]
    })

    it('should render system notifications', () => {
      render(<EventsView />)
      expect(screen.getByText('events.systemNotifications')).toBeInTheDocument()
      expect(screen.getByText('Session Conflict')).toBeInTheDocument()
      expect(screen.getByText('Another device connected')).toBeInTheDocument()
    })

    it('should call dismissNotification when dismiss is clicked', async () => {
      render(<EventsView />)

      const dismissButton = screen.getByLabelText('sidebar.dismiss')
      fireEvent.click(dismissButton)

      expect(mockDismissNotification).toHaveBeenCalledWith('notif1')
    })
  })

  describe('mixed events', () => {
    it('should render all event types when present', () => {
      mockSubscriptionRequests = [{ id: 'req1', from: 'alice@example.com' }]
      mockStrangerConversations = {
        'stranger@example.com': [{ id: 'msg1', from: 'stranger@example.com', body: 'Hi', timestamp: new Date() }],
      }
      mockMucInvitations = [{ id: 'inv1', roomJid: 'room@conference.example.com', from: 'friend@example.com' }]
      mockSystemNotifications = [{ id: 'notif1', type: 'auth-error', title: 'Error', message: 'Auth failed' }]

      render(<EventsView />)

      expect(screen.getByText(/events.subscriptionRequests/)).toBeInTheDocument()
      expect(screen.getByText(/events.messagesFromStrangers/)).toBeInTheDocument()
      expect(screen.getByText(/events.roomInvitations/)).toBeInTheDocument()
      expect(screen.getByText('events.systemNotifications')).toBeInTheDocument()
    })
  })
})
