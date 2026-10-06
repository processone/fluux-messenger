import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, createEvent, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { MessageReactorsSheet } from './MessageReactorsSheet'
import { useMessageSelection } from '@/hooks/useMessageSelection'
import { useTypeToFocus } from '@/hooks/useTypeToFocus'
import { messageTargetRowId } from './messageRowIdentity'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../Avatar', () => ({
  Avatar: ({ name, avatarUrl }: { name: string; avatarUrl?: string }) => <img alt={name} src={avatarUrl} />,
}))

const props = {
  reactions: { '👍': ['alice'], '❤️': ['bob'] },
  initialEmoji: '❤️',
  getReactorName: (id: string) => id === 'alice' ? 'Alice' : 'Bob',
  onClose: vi.fn(),
}

const messages = [{ id: 'first' }, { id: 'second' }]
function ConversationFixture({ onEnterPressed, onKeyboardNavigate, onKeyboardScrolled, onReachedFirstMessage, empty = false }: {
  onEnterPressed: (id: string) => void
  onKeyboardNavigate: () => void
  onKeyboardScrolled: () => void
  onReachedFirstMessage?: () => void
  empty?: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  useTypeToFocus(composerRef)
  const [open, setOpen] = useState(false)
  const rows = empty ? [] : messages
  const selection = useMessageSelection(rows, scrollRef, { onEnterPressed, onKeyboardNavigate, onKeyboardScrolled, onReachedFirstMessage })
  return (
    <div ref={scrollRef} tabIndex={0} onKeyDown={selection.handleKeyDown} data-testid="conversation">
      <output data-testid="selection">{selection.selectedMessageId ?? 'none'}</output>
      {rows.map(message => <div key={message.id} data-message-row-id={messageTargetRowId(message.id)} data-testid={message.id}>{message.id}</div>)}
      <button type="button" onClick={() => setOpen(true)}>Open reactors</button>
      <textarea ref={composerRef} aria-label="Composer" />
      {open && <MessageReactorsSheet {...props} onClose={() => setOpen(false)} />}
    </div>
  )
}

describe('MessageReactorsSheet', () => {
  it.each([' ', 'a', '@', 'Backspace', 'Delete'])('keeps modal focus during typing-to-focus key %j', (key) => {
    render(<ConversationFixture onEnterPressed={vi.fn()} onKeyboardNavigate={vi.fn()} onKeyboardScrolled={vi.fn()} />)
    const conversation = screen.getByTestId('conversation')
    const composer = screen.getByRole('textbox', { name: 'Composer' })
    conversation.focus()
    fireEvent.click(screen.getByRole('button', { name: 'Open reactors' }))
    const dialog = screen.getByRole('dialog')
    const close = screen.getByRole('button', { name: 'common.close' })
    const focus = vi.spyOn(composer, 'focus')
    try {
      for (const target of [close, screen.getByRole('tab', { name: '❤️ 1' }), screen.getByRole('tabpanel')]) {
        target.focus()
        const event = createEvent.keyDown(target, { key, shiftKey: key === '@' })
        fireEvent(target, event)
        expect(event.defaultPrevented).toBe(false)
        expect(target).toHaveFocus()
        expect(dialog).toContainElement(document.activeElement as HTMLElement)
        expect(focus).not.toHaveBeenCalled()
      }
      close.focus()
      fireEvent.keyUp(close, { key: ' ' })
      fireEvent.click(close)
      expect(screen.queryByRole('dialog')).toBeNull()
      conversation.focus()
      fireEvent.keyDown(conversation, { key, shiftKey: key === '@' })
      expect(composer).toHaveFocus()
      expect(focus).toHaveBeenCalledOnce()
    } finally { focus.mockRestore() }
  })

  it('does not load conversation history from modal keys when the resident list is empty', () => {
    const onReachedFirstMessage = vi.fn()
    render(<ConversationFixture empty onReachedFirstMessage={onReachedFirstMessage} onEnterPressed={vi.fn()} onKeyboardNavigate={vi.fn()} onKeyboardScrolled={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open reactors' }))
    fireEvent.keyDown(screen.getByRole('tabpanel'), { key: 'ArrowUp' })
    expect(onReachedFirstMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    fireEvent.keyDown(screen.getByTestId('conversation'), { key: 'ArrowUp' })
    expect(onReachedFirstMessage).toHaveBeenCalledOnce()
  })

  it.each([false, true])('isolates modal keys from conversation selection with preselected=%s', (preselected) => {
    const onEnterPressed = vi.fn()
    const onKeyboardNavigate = vi.fn()
    const onKeyboardScrolled = vi.fn()
    render(<ConversationFixture onEnterPressed={onEnterPressed} onKeyboardNavigate={onKeyboardNavigate} onKeyboardScrolled={onKeyboardScrolled} />)
    const conversation = screen.getByTestId('conversation')
    const firstScroll = vi.spyOn(screen.getByTestId('first'), 'scrollIntoView')
    const secondScroll = vi.spyOn(screen.getByTestId('second'), 'scrollIntoView')
    try {
      if (preselected) {
        fireEvent.keyDown(conversation, { key: 'ArrowUp' })
        fireEvent.keyDown(conversation, { key: 'ArrowUp' })
        expect(screen.getByTestId('selection')).toHaveTextContent('first')
      }
      firstScroll.mockClear()
      secondScroll.mockClear()
      onKeyboardNavigate.mockClear()
      onKeyboardScrolled.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Open reactors' }))
      const close = screen.getByRole('button', { name: 'common.close' })
      for (const target of [close, screen.getByRole('tab', { name: '❤️ 1' }), screen.getByRole('tabpanel')]) {
        fireEvent.keyDown(target, { key: 'ArrowDown' })
        fireEvent.keyDown(target, { key: 'ArrowUp' })
      }
      expect(screen.getByTestId('selection')).toHaveTextContent(preselected ? 'first' : 'none')
      expect(onKeyboardNavigate).not.toHaveBeenCalled()
      expect(onKeyboardScrolled).not.toHaveBeenCalled()
      expect(firstScroll).not.toHaveBeenCalled()
      expect(secondScroll).not.toHaveBeenCalled()
      close.focus()
      const enter = createEvent.keyDown(close, { key: 'Enter' })
      fireEvent(close, enter)
      expect(enter.defaultPrevented).toBe(false)
      expect(onEnterPressed).not.toHaveBeenCalled()
      fireEvent.click(close)
      expect(screen.queryByRole('dialog')).toBeNull()
      conversation.focus()
      fireEvent.keyDown(conversation, { key: 'ArrowDown' })
      expect(screen.getByTestId('selection')).toHaveTextContent('second')
      expect(secondScroll).toHaveBeenCalledOnce()
      expect(onKeyboardNavigate).toHaveBeenCalledOnce()
      expect(onKeyboardScrolled).toHaveBeenCalledOnce()
      fireEvent.keyDown(conversation, { key: 'Enter' })
      expect(onEnterPressed).toHaveBeenCalledExactlyOnceWith('second')
    } finally { firstScroll.mockRestore(); secondScroll.mockRestore() }
  })

  it('preserves sheet tab keys and Escape with a real conversation ancestor handler', () => {
    const onEnterPressed = vi.fn()
    const onKeyboardNavigate = vi.fn()
    const onKeyboardScrolled = vi.fn()
    render(<ConversationFixture onEnterPressed={onEnterPressed} onKeyboardNavigate={onKeyboardNavigate} onKeyboardScrolled={onKeyboardScrolled} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open reactors' }))
    const heart = screen.getByRole('tab', { name: '❤️ 1' })
    heart.focus()
    fireEvent.keyDown(heart, { key: 'Home' })
    const thumbs = screen.getByRole('tab', { name: '👍 1' })
    expect(thumbs).toHaveFocus()
    expect(thumbs).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(thumbs, { key: 'End' })
    expect(heart).toHaveFocus()
    fireEvent.keyDown(heart, { key: 'ArrowLeft' })
    expect(thumbs).toHaveFocus()
    fireEvent.keyDown(thumbs, { key: 'ArrowRight' })
    expect(heart).toHaveFocus()
    expect(screen.getByTestId('selection')).toHaveTextContent('none')
    fireEvent.keyDown(heart, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onEnterPressed).not.toHaveBeenCalled()
    expect(onKeyboardNavigate).not.toHaveBeenCalled()
    expect(onKeyboardScrolled).not.toHaveBeenCalled()
  })

  it('shows the selected reactors with their existing avatar data', () => {
    render(<MessageReactorsSheet {...props} getReactorDetails={(id) => ({ name: id === 'bob' ? 'Room Nick' : 'Alice', avatarIdentifier: id, avatarUrl: '/fixture-avatar.png' })} />)
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Room Nick')
    expect(screen.getByRole('img', { name: 'Room Nick' })).toHaveAttribute('src', '/fixture-avatar.png')
    expect(screen.getByRole('tab', { name: '❤️ 1' })).toHaveAttribute('aria-selected', 'true')
  })

  it('supports keyboard tab navigation and Escape dismissal', () => {
    const onClose = vi.fn()
    render(<MessageReactorsSheet {...props} onClose={onClose} />)
    const heart = screen.getByRole('tab', { name: '❤️ 1' })
    heart.focus()
    fireEvent.keyDown(heart, { key: 'Home' })
    const thumbs = screen.getByRole('tab', { name: '👍 1' })
    expect(thumbs).toHaveFocus()
    expect(thumbs).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Alice')
    fireEvent.keyDown(thumbs, { key: 'ArrowRight' })
    expect(heart).toHaveFocus()
    fireEvent.keyDown(heart, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('falls back to an available tab if the selected emoji is removed', () => {
    const { rerender } = render(<MessageReactorsSheet {...props} />)
    screen.getByRole('tab', { name: '❤️ 1' }).focus()
    const thumbs = screen.getByRole('tab', { name: '👍 1' })
    const focus = vi.spyOn(thumbs, 'focus')
    try {
      rerender(<MessageReactorsSheet {...props} reactions={{ '👍': ['alice'] }} />)
      expect(within(screen.getByRole('tabpanel')).getByText('Alice')).toBeInTheDocument()
      expect(thumbs).toHaveAttribute('aria-selected', 'true')
      expect(thumbs).toHaveFocus()
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
    } finally { focus.mockRestore() }
  })

  const readers = Array.from({ length: 30 }, (_, index) => `reader-${index}`)
  it.each<[string, Record<string, string[]>, string, number]>([
    ['reactor addition', { '👍': [...readers, 'new-reader'], '❤️': ['bob'] }, '👍', 31],
    ['reactor removal', { '👍': readers.slice(0, -1), '❤️': ['bob'] }, '👍', 29],
    ['tab reordering', { '👍': readers, '❤️': [...readers, 'bob'] }, '👍', 30],
    ['unselected tab removal', { '👍': readers }, '👍', 30],
    ['selected tab removal', { '❤️': ['bob'] }, '❤️', 1],
  ])('preserves a scrolled reactor list during %s', (_change, reactions, selectedEmoji, count) => {
    const getReactorName = (id: string) => id
    const { rerender } = render(<MessageReactorsSheet {...props} initialEmoji="👍" reactions={{ '👍': readers, '❤️': ['bob'] }} getReactorName={getReactorName} />)
    screen.getByRole('tab', { name: '👍 30' }).focus()
    const scroller = screen.getByRole('tabpanel').parentElement!
    scroller.scrollTop = 400
    const scrolls = screen.getAllByRole('tab').map(tab => vi.spyOn(tab, 'scrollIntoView').mockImplementation(() => { scroller.scrollTop = 0 }))
    try {
      rerender(<MessageReactorsSheet {...props} initialEmoji="👍" reactions={reactions} getReactorName={getReactorName} />)
      expect(within(screen.getByRole('tabpanel')).getAllByRole('listitem')).toHaveLength(count)
      expect(screen.getByRole('tab', { name: `${selectedEmoji} ${count}` })).toHaveAttribute('aria-selected', 'true')
      expect(scroller.scrollTop).toBe(400)
      for (const scroll of scrolls) expect(scroll).not.toHaveBeenCalled()
    } finally { for (const scroll of scrolls) scroll.mockRestore() }
  })

  it('still reveals a tab selected by the reader', () => {
    render(<MessageReactorsSheet {...props} />)
    const thumbs = screen.getByRole('tab', { name: '👍 1' })
    const scroll = vi.spyOn(thumbs, 'scrollIntoView')
    try {
      fireEvent.click(thumbs)
      expect(thumbs).toHaveAttribute('aria-selected', 'true')
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    } finally { scroll.mockRestore() }
  })

  it.each(['tab', 'panel', 'reactor', 'close', 'backdrop'])('isolates %s clicks from ancestor row activation', (target) => {
    const onRowClick = vi.fn()
    const onClose = vi.fn()
    render(<div onClick={onRowClick}><MessageReactorsSheet {...props} onClose={onClose} /></div>)
    const dialog = screen.getByRole('dialog')
    const element = target === 'tab' ? screen.getByRole('tab', { name: '👍 1' })
      : target === 'panel' ? screen.getByRole('tabpanel')
      : target === 'reactor' ? screen.getByText('Bob')
      : target === 'close' ? screen.getByRole('button', { name: 'common.close' })
      : dialog.parentElement!.querySelector<HTMLButtonElement>('button[aria-hidden="true"]')!
    fireEvent.click(element)
    expect(onRowClick).not.toHaveBeenCalled()
    if (target === 'close' || target === 'backdrop') expect(onClose).toHaveBeenCalledOnce()
    if (target === 'tab') expect(screen.getByRole('tabpanel')).toHaveTextContent('Alice')
  })

  it('does not move focus away from another sheet control on tab removal', () => {
    const { rerender } = render(<MessageReactorsSheet {...props} />)
    screen.getByRole('tab', { name: '❤️ 1' }).focus()
    const close = screen.getByRole('button', { name: 'common.close' })
    close.focus()
    rerender(<MessageReactorsSheet {...props} reactions={{ '👍': ['alice'] }} />)
    expect(close).toHaveFocus()
  })

  it('keeps focus on a surviving tab when counts reorder the tabs', () => {
    const { rerender } = render(<MessageReactorsSheet {...props} />)
    const heart = screen.getByRole('tab', { name: '❤️ 1' })
    heart.focus()
    rerender(<MessageReactorsSheet {...props} reactions={{ '👍': ['alice'], '❤️': ['bob', 'carol'] }} />)
    expect(heart).toHaveFocus()
    expect(heart).toHaveAttribute('aria-selected', 'true')
  })
})
