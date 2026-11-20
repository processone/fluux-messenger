/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageBubble, type MessageBubbleProps } from './MessageBubble'
import type { BaseMessage } from '@fluux/sdk'

const saved = vi.hoisted(() => ({ isSaved: false }))
vi.mock('./useSavedMessageAction', () => ({
  useSavedMessageAction: () => ({ isSaved: saved.isSaved, onToggleSaved: vi.fn() }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('date-fns', () => ({ format: vi.fn(() => '14:30') }))
vi.mock('../Avatar', () => ({ Avatar: () => <div data-testid="avatar" /> }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { densityMode: string }) => unknown) => selector({ densityMode: 'comfortable' }),
}))

const message = (extra: Partial<BaseMessage> = {}): BaseMessage => ({
  type: 'chat', id: 'msg-1', from: 'alice@example.com', body: 'Hello', timestamp: new Date('2024-01-15T14:30:00Z'),
  isOutgoing: false, stanzaId: undefined, originId: undefined, ...extra,
})
const props = (m: BaseMessage): MessageBubbleProps => ({
  message: m, showAvatar: true, isLastOutgoing: false, isLastMessage: false, senderName: 'Alice',
  senderColor: 'rgb(1,1,1)', avatarIdentifier: 'alice@example.com', myReactions: [], onReaction: vi.fn(),
  getReactorName: vi.fn((id) => id), onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), formatTime: () => '14:30', timeFormat: '24h',
})

describe('MessageBubble saved marker', () => {
  it('shows a labelled marker on a saved message', () => {
    saved.isSaved = true
    render(<MessageBubble {...props(message())} />)
    expect(screen.getByTestId('saved-marker')).toHaveAttribute('aria-label', 'saved.marker')
  })
  it('shows no marker on an unsaved message', () => {
    saved.isSaved = false
    render(<MessageBubble {...props(message())} />)
    expect(screen.queryByTestId('saved-marker')).toBeNull()
  })
})
