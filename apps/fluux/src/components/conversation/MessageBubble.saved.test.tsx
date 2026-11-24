/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MessageBubble, type MessageBubbleProps } from './MessageBubble'
import { buildSavedMessage, savedStore, type BaseMessage, type Message } from '@fluux/sdk'
import { useSavedStore } from '@fluux/sdk/react'
import { useStore } from 'zustand'

function useLiveSaved(selector?: (state: ReturnType<typeof savedStore.getState>) => unknown) {
  return useStore(savedStore, selector ?? (state => state))
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('date-fns', () => ({ format: vi.fn(() => '14:30') }))
vi.mock('../Avatar', () => ({ Avatar: () => <div data-testid="avatar" /> }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { densityMode: string }) => unknown) => selector({ densityMode: 'comfortable' }),
}))

const message = (extra: Partial<Message> = {}): Message => ({
  type: 'chat', id: 'msg-1', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'Hello', timestamp: new Date('2024-01-15T14:30:00Z'),
  isOutgoing: false, stanzaId: 'archive-msg-1', originId: undefined, ...extra,
})
const save = () => savedStore.getState().save({ ...buildSavedMessage(message(), '', 1000), id: 'saved-entry' })
const props = (m: BaseMessage): MessageBubbleProps => ({
  message: m, showAvatar: true, isLastOutgoing: false, isLastMessage: false, senderName: 'Alice',
  senderColor: 'rgb(1,1,1)', avatarIdentifier: 'alice@example.com', myReactions: [], onReaction: vi.fn(),
  getReactorName: vi.fn((id) => id), onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), formatTime: () => '14:30', timeFormat: '24h',
})

describe('MessageBubble saved marker', () => {
  beforeEach(() => {
    localStorage.clear()
    savedStore.getState().reset()
    vi.mocked(useSavedStore).mockImplementation(useLiveSaved)
  })

  it('offers a remove-only action even when the hover toolbar is hidden', () => {
    save()
    render(<MessageBubble {...props(message())} hideToolbar />)
    const button = screen.getByRole('button', { name: 'chat.removeFromSaved' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('title', 'chat.removeFromSaved')
    const row = button.closest('[data-message-id]')!
    expect(row).toHaveAttribute('data-msg-saved-slot')
    fireEvent.click(button)
    expect(row).not.toHaveAttribute('data-msg-saved-slot')
    expect(savedStore.getState().entries).toEqual({})
    expect(savedStore.getState().pending).toEqual({ 'saved-entry': 'retract' })
  })

  it('keeps the Search and Saved preview marker passive', () => {
    save()
    render(<MessageBubble {...props(message())} readOnlyActions />)
    expect(screen.getByRole('img', { name: 'saved.marker' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'chat.removeFromSaved' })).toBeNull()
    fireEvent.click(screen.getByTestId('saved-marker'))
    expect(Object.keys(savedStore.getState().entries)).toEqual(['saved-entry'])
  })

  it('shows no marker for a deleted original', () => {
    save()
    render(<MessageBubble {...props(message({ isRetracted: true }))} />)
    expect(screen.queryByTestId('saved-marker')).toBeNull()
  })

  it('returns focused removal to the conversation without scrolling and consumes button keys', () => {
    save()
    const key = vi.fn()
    render(<div className="focus-zone" tabIndex={0} onKeyDown={key} onKeyUp={key} data-testid="conversation"><MessageBubble {...props(message())} /></div>)
    const button = screen.getByRole('button', { name: 'chat.removeFromSaved' })
    button.focus()
    for (const value of ['Enter', ' ']) {
      fireEvent.keyDown(button, { key: value })
      fireEvent.keyUp(button, { key: value })
    }
    expect(key).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: 'ArrowUp' })
    fireEvent.keyUp(button, { key: 'ArrowUp' })
    expect(key).toHaveBeenCalledTimes(2)
    expect(key).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: 'ArrowUp', type: 'keydown' }))
    expect(key).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: 'ArrowUp', type: 'keyup' }))
    const zone = screen.getByTestId('conversation')
    const focus = vi.spyOn(zone, 'focus')
    act(() => savedStore.getState().remove('saved-entry'))
    expect(zone).toHaveFocus()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('does not move focus when an unfocused marker disappears', () => {
    save()
    render(<div className="focus-zone" tabIndex={0}><input aria-label="Draft" /><MessageBubble {...props(message())} /></div>)
    screen.getByRole('textbox', { name: 'Draft' }).focus()
    act(() => savedStore.getState().remove('saved-entry'))
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus()
  })
  it('shows no marker on an unsaved message', () => {
    render(<MessageBubble {...props(message())} />)
    expect(screen.queryByTestId('saved-marker')).toBeNull()
  })
})
