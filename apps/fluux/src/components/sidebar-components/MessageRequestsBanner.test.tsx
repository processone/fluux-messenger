import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

const acceptStranger = vi.fn().mockResolvedValue(undefined)
const ignoreStranger = vi.fn()
const blockJid = vi.fn().mockResolvedValue(undefined)
const setActiveConversation = vi.fn()
const navigateToMessages = vi.fn()
let strangerConversations: Record<string, Array<{ id: string; from: string; body: string; timestamp: Date }>> = {}

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useEvents: () => ({ strangerConversations, acceptStranger, ignoreStranger }),
    useBlocking: () => ({ blockJid }),
    getBareJid: (jid: string) => jid.split('/')[0],
  }
})
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (sel: (s: { setActiveConversation: typeof setActiveConversation }) => unknown) => sel({ setActiveConversation }),
}))
vi.mock('@/hooks', () => ({ useRouteSync: () => ({ navigateToMessages }) }))

import { MessageRequestsBanner } from './MessageRequestsBanner'
import { messageRequestPreviewStore } from '@/stores/messageRequestPreviewStore'

describe('MessageRequestsBanner', () => {
  beforeEach(() => { vi.clearAllMocks(); strangerConversations = {}; messageRequestPreviewStore.getState().setPreviewJid(null) })

  it('renders nothing when there are no stranger conversations', () => {
    const { container } = render(<MessageRequestsBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('accepts a stranger and navigates into the conversation', async () => {
    strangerConversations = { 'x@example.com': [{ id: 'm1', from: 'x@example.com', body: 'hi', timestamp: new Date() }] }
    render(<MessageRequestsBanner />)
    fireEvent.click(screen.getByText('common.accept'))
    await waitFor(() => expect(acceptStranger).toHaveBeenCalledWith('x@example.com'))
    expect(navigateToMessages).toHaveBeenCalledWith('x@example.com')
  })

  it('opens the preview for a stranger when its row is clicked', () => {
    strangerConversations = { 'x@example.com': [{ id: 'm1', from: 'x@example.com', body: 'hi', timestamp: new Date() }] }
    render(<MessageRequestsBanner />)
    fireEvent.click(screen.getByText('x'))
    expect(messageRequestPreviewStore.getState().previewJid).toBe('x@example.com')
  })
})
