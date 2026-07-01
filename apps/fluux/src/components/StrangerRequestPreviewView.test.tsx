/**
 * Tests for StrangerRequestPreviewView
 *
 * Renders the read-only message-request preview view and verifies:
 * - Both stranger message bodies appear in the DOM
 * - Accept / Ignore / Block buttons call their respective callbacks
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StrangerRequestPreviewView } from './StrangerRequestPreviewView'

// ---------------------------------------------------------------------------
// i18n — use t(key) identity transform (fast, no async init needed)
// ---------------------------------------------------------------------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
}))

// ---------------------------------------------------------------------------
// App hooks
// ---------------------------------------------------------------------------
vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({ dragRegionProps: {} }),
  useMode: () => ({ resolvedMode: 'light', isDark: false }),
}))

// ---------------------------------------------------------------------------
// SearchContextMessageList — render message bodies as plain text so jsdom
// doesn't have to boot the full virtualizer / MessageBubble tree.
// ---------------------------------------------------------------------------
vi.mock('./SearchContextView', () => ({
  SearchContextMessageList: ({ messages }: { messages: { body: string; id: string }[] }) => (
    <div data-testid="message-list">
      {messages.map((m) => (
        <div key={m.id} data-testid="message-body">
          {m.body}
        </div>
      ))}
    </div>
  ),
}))

// ---------------------------------------------------------------------------
// Avatar — lightweight stub
// ---------------------------------------------------------------------------
vi.mock('./Avatar', () => ({
  Avatar: ({ name }: { name?: string }) => <div data-testid="avatar">{name}</div>,
}))

// ---------------------------------------------------------------------------
// SDK mocks
// ---------------------------------------------------------------------------
const STRANGER_JID = 'stranger@example.com'

const mockStrangerMessages = [
  { id: 'msg-1', from: STRANGER_JID, body: 'Hello there!', timestamp: new Date('2024-01-01T10:00:00Z') },
  { id: 'msg-2', from: STRANGER_JID, body: 'Are you around?', timestamp: new Date('2024-01-01T10:01:00Z') },
]

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useEvents: vi.fn(() => ({
      strangerConversations: {
        [STRANGER_JID]: mockStrangerMessages,
      },
      subscriptionRequests: [],
      strangerMessages: mockStrangerMessages,
      mucInvitations: [],
      systemNotifications: [],
      pendingCount: 1,
      acceptStranger: vi.fn(),
      ignoreStranger: vi.fn(),
      acceptSubscription: vi.fn(),
      rejectSubscription: vi.fn(),
      acceptInvitation: vi.fn(),
      declineInvitation: vi.fn(),
      dismissNotification: vi.fn(),
    })),
    useContactIdentities: vi.fn(() => new Map()),
  }
})

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      jid: 'me@example.com/res',
      ownAvatar: null,
      ownNickname: 'Me',
    }
    return selector ? selector(state) : state
  }),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('StrangerRequestPreviewView', () => {
  const onAccept = vi.fn()
  const onIgnore = vi.fn()
  const onBlock = vi.fn()
  const onBack = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderView() {
    return render(
      <StrangerRequestPreviewView
        strangerJid={STRANGER_JID}
        onAccept={onAccept}
        onIgnore={onIgnore}
        onBlock={onBlock}
        onBack={onBack}
      />
    )
  }

  it('renders both stranger message bodies', () => {
    renderView()
    expect(screen.getByText('Hello there!')).toBeInTheDocument()
    expect(screen.getByText('Are you around?')).toBeInTheDocument()
  })

  it('calls onAccept when Accept is clicked', () => {
    renderView()
    fireEvent.click(screen.getByText('Accept'))
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('calls onIgnore when Ignore is clicked', () => {
    renderView()
    fireEvent.click(screen.getByText('Ignore'))
    expect(onIgnore).toHaveBeenCalledTimes(1)
  })

  it('calls onBlock when Block is clicked', () => {
    renderView()
    fireEvent.click(screen.getByText('Block'))
    expect(onBlock).toHaveBeenCalledTimes(1)
  })

  it('shows the back button and calls onBack when clicked', () => {
    renderView()
    const backBtn = screen.getByRole('button', { name: 'Back' })
    fireEvent.click(backBtn)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows the stranger display name in the header', () => {
    renderView()
    // "stranger" appears in both the Avatar stub and the header title
    const matches = screen.getAllByText('stranger')
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('shows the message-request subtitle', () => {
    renderView()
    expect(screen.getByText('Message request')).toBeInTheDocument()
  })
})
