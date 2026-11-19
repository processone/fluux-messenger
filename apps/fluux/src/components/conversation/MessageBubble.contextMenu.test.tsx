/** @vitest-environment jsdom */
// Intent (FLM-347): a right-click on a message opens Fluux's message menu at the pointer.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { BaseMessage } from '@fluux/sdk'
import { MessageBubble, type MessageBubbleProps } from './MessageBubble'
import { MessageInteractionContext } from './useMessageInteractionHold'

const copy = vi.hoisted(() => vi.fn())
const open = vi.hoisted(() => vi.fn())
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: copy }))
vi.mock('@/utils/openInBrowser', () => ({ openInBrowser: open }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('date-fns', () => ({ format: vi.fn(() => '14:30') }))
vi.mock('./messageGrouping', () => ({
  scrollToMessage: vi.fn(),
  isActionMessage: (body?: string) => body?.startsWith('/me '),
}))
vi.mock('../Avatar', () => ({ Avatar: () => <div /> }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { densityMode: string }) => unknown) => selector({ densityMode: 'comfortable' }),
}))

function message(overrides: Partial<BaseMessage> = {}): BaseMessage {
  return {
    stanzaId: undefined, originId: undefined, type: 'chat', id: 'msg-1', from: 'alice@example.com',
    body: 'Hello, world!', timestamp: new Date('2024-01-15T14:30:00Z'), isOutgoing: false, ...overrides,
  }
}

function props(overrides: Partial<MessageBubbleProps> = {}): MessageBubbleProps {
  return {
    message: message(), showAvatar: true, isLastOutgoing: false, isLastMessage: false, senderName: 'Alice',
    senderColor: 'rgb(100, 100, 200)', avatarIdentifier: 'alice@example.com', myReactions: [],
    onReaction: vi.fn(), getReactorName: vi.fn((id) => id), onReply: vi.fn(), onEdit: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined), formatTime: () => '14:30', timeFormat: '24h', ...overrides,
  }
}

const menu = () => screen.queryByRole('menu', { name: 'chat.moreOptions' })

describe('message right-click menu', () => {
  afterEach(() => { window.getSelection()?.removeAllRanges(); copy.mockClear(); open.mockClear() })

  it('opens at the pointer with the reactions row on top, and keeps the browser menu away', () => {
    const p = props()
    render(<MessageBubble {...p} />)
    const notPrevented = fireEvent.contextMenu(screen.getByText('Hello, world!'), { clientX: 120, clientY: 80 })
    expect(notPrevented).toBe(false)
    const m = menu()!
    expect(m).toHaveStyle({ left: '120px', top: '80px' })
    const items = within(m).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)
    expect(items.slice(0, 4)).toEqual(['chat.reactWith', 'chat.reactWith', 'chat.reactWith', 'chat.moreReactions'])
    expect(items.slice(4)).toEqual(['chat.reply', 'chat.copyMessage', 'chat.editMessage', 'chat.deleteMessage'].filter((i) => items.includes(i)))
    fireEvent.click(within(m).getByRole('button', { name: 'chat.reply' }))
    expect(p.onReply).toHaveBeenCalledOnce()
    expect(menu()).toBeNull()
  })

  it('leaves Shift + right-click to the system menu', () => {
    render(<MessageBubble {...props()} />)
    const notPrevented = fireEvent.contextMenu(screen.getByText('Hello, world!'), { shiftKey: true })
    expect(notPrevented).toBe(true)
    expect(menu()).toBeNull()
  })

  it('opens nothing on a retracted message', () => {
    render(<MessageBubble {...props({ message: message({ isRetracted: true }) })} />)
    fireEvent.contextMenu(screen.getByText('chat.messageDeleted'))
    expect(menu()).toBeNull()
  })

  function select(node: Node) {
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }

  it('offers Copy for words selected before the click', () => {
    render(<MessageBubble {...props()} />)
    const text = screen.getByText('Hello, world!')
    select(text)
    fireEvent.mouseDown(text, { button: 2 })
    fireEvent.contextMenu(text)
    const m = menu()!
    const buttons = within(m).getAllByRole('button')
    expect(buttons[4]).toHaveTextContent('chat.selection.copy')
    fireEvent.click(buttons[4])
    expect(copy).toHaveBeenCalledWith('Hello, world!')
  })

  it('does not count a word that only the right-click selected', () => {
    render(<MessageBubble {...props()} />)
    const text = screen.getByText('Hello, world!')
    fireEvent.mouseDown(text, { button: 2 }) // nothing selected as the button goes down
    select(text) // the system then selects the word under the pointer
    fireEvent.contextMenu(text)
    expect(within(menu()!).queryByText('chat.selection.copy')).toBeNull()
  })

  it('offers Copy link and Open in browser on a link', () => {
    render(<MessageBubble {...props({ message: message({ body: 'see https://example.com/a now' }) })} />)
    fireEvent.contextMenu(screen.getByRole('link'))
    const m = menu()!
    // The link's own popup does not open beside it.
    expect(screen.getAllByText('chat.openInBrowser')).toHaveLength(1)
    fireEvent.click(within(m).getByRole('button', { name: 'chat.openInBrowser' }))
    expect(open).toHaveBeenCalledWith('https://example.com/a')
  })

  it('offers image items over an inline image', () => {
    const attachment = { url: 'https://example.com/pic.png', name: 'pic.png', mediaType: 'image/png', width: 10, height: 10 }
    render(<MessageBubble {...props({ message: message({ body: '', attachment }) })} />)
    fireEvent.contextMenu(screen.getByRole('img'))
    const m = menu()!
    expect(within(m).getByRole('button', { name: 'chat.saveImage' })).toBeInTheDocument()
    fireEvent.click(within(m).getByRole('button', { name: 'chat.copyImageUrl' }))
    expect(copy).toHaveBeenCalledWith('https://example.com/pic.png')
  })

  it('does not show image items away from the image', () => {
    const attachment = { url: 'https://example.com/pic.png', name: 'pic.png', mediaType: 'image/png', width: 10, height: 10 }
    render(<MessageBubble {...props({ message: message({ body: 'caption', attachment }) })} />)
    fireEvent.contextMenu(screen.getByText('caption'))
    expect(within(menu()!).queryByText('chat.saveImage')).toBeNull()
  })

  it('shows one Copy link over a link, and the chooser only when no link is under the pointer', () => {
    const body = 'a https://example.com/a b https://example.com/b'
    render(<MessageBubble {...props({ message: message({ body }) })} />)
    fireEvent.contextMenu(screen.getAllByRole('link')[0])
    expect(within(menu()!).getAllByText('chat.copyLink')).toHaveLength(1)
    fireEvent.click(within(menu()!).getByText('chat.copyLink'))
    expect(copy).toHaveBeenCalledWith('https://example.com/a')
    fireEvent.contextMenu(screen.getByText(/^a /))
    expect(within(menu()!).getAllByText('chat.copyLink')).toHaveLength(1)
  })

  it('reopens on the actions after a picker was used', () => {
    render(<MessageBubble {...props()} />)
    const text = screen.getByText('Hello, world!')
    fireEvent.contextMenu(text)
    fireEvent.click(within(menu()!).getByRole('button', { name: 'chat.moreReactions' }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.mouseDown(document.body)
    fireEvent.contextMenu(text)
    expect(within(menu()!).getAllByRole('button', { name: 'chat.reactWith' })).toHaveLength(3)
  })

  it('unselects a word the right-click selected', () => {
    render(<MessageBubble {...props()} />)
    const text = screen.getByText('Hello, world!')
    fireEvent.mouseDown(text, { button: 2 })
    select(text)
    fireEvent.contextMenu(text)
    expect(window.getSelection()?.toString()).toBe('')
  })

  it('closes when the message is retracted and never offers deleted text', () => {
    const p = props()
    const view = render(<MessageBubble {...p} />)
    fireEvent.contextMenu(screen.getByText('Hello, world!'))
    expect(menu()).not.toBeNull()
    view.rerender(<MessageBubble {...p} message={{ ...p.message, isRetracted: true }} />)
    expect(menu()).toBeNull()
    const notice = screen.getByText('chat.messageDeleted')
    select(notice)
    fireEvent.contextMenu(notice)
    expect(menu()).toBeNull()
  })

  it('offers image items only over the message attachment, not another image in the row', () => {
    const attachment = { url: 'https://example.com/pic.png', name: 'pic.png', mediaType: 'image/png', width: 10, height: 10 }
    render(<MessageBubble {...props({ message: message({ body: 'caption', attachment }) })} />)
    const other = document.createElement('img')
    screen.getByText('caption').appendChild(other)
    fireEvent.contextMenu(other)
    expect(within(menu()!).queryByText('chat.saveImage')).toBeNull()
  })

  it('registers with the interaction hold while open and does not click through its portal', () => {
    const setMenuOpen = vi.fn()
    const onRowClick = vi.fn()
    const ctx = { heldMessageId: null, heldRow: null, subscribe: () => () => {}, isHeld: () => false, setMenuOpen }
    render(
      <MessageInteractionContext.Provider value={ctx}>
        <div onClick={onRowClick}><MessageBubble {...props()} /></div>
      </MessageInteractionContext.Provider>,
    )
    fireEvent.contextMenu(screen.getByText('Hello, world!'))
    expect(setMenuOpen).toHaveBeenLastCalledWith(expect.any(String), true, expect.any(Function), undefined)
    fireEvent.click(within(menu()!).getByRole('button', { name: 'chat.copyMessage' }))
    expect(onRowClick).not.toHaveBeenCalled()
    expect(setMenuOpen).toHaveBeenLastCalledWith(expect.any(String), false, expect.any(Function), undefined)
  })

  it('hides Reply, Edit and Delete in a read-only preview but keeps the copy actions', () => {
    render(<MessageBubble {...props({ message: message({ isOutgoing: true }), isLastOutgoing: true, readOnlyActions: true })} />)
    fireEvent.contextMenu(screen.getByText('Hello, world!'))
    const m = menu()!
    expect(within(m).queryByRole('button', { name: 'chat.reply' })).toBeNull()
    expect(within(m).queryByRole('button', { name: 'chat.editMessage' })).toBeNull()
    expect(within(m).queryByRole('button', { name: 'chat.deleteMessage' })).toBeNull()
    expect(within(m).getByRole('button', { name: 'chat.copyMessage' })).toBeInTheDocument()
  })

  it('keeps the system menu inside the popup for Shift and text fields, and the keyboard out of the list', () => {
    const onKeyDown = vi.fn()
    render(<div onKeyDown={onKeyDown}><MessageBubble {...props()} /></div>)
    fireEvent.contextMenu(screen.getByText('Hello, world!'))
    const m = menu()!
    expect(m).toHaveAttribute('data-modal', 'true')
    expect(fireEvent.contextMenu(within(m).getByRole('button', { name: 'chat.reply' }), { shiftKey: true })).toBe(true)
    expect(fireEvent.contextMenu(within(m).getByRole('button', { name: 'chat.reply' }))).toBe(false)
    const field = document.createElement('input')
    m.appendChild(field)
    expect(fireEvent.contextMenu(field)).toBe(true)
  })

  it('limits a long menu to the window height so it can scroll', () => {
    render(<MessageBubble {...props()} />)
    fireEvent.contextMenu(screen.getByText('Hello, world!'))
    const classes = menu()!.className
    expect(classes).toContain('max-h-[calc(100dvh-1rem)]')
    expect(classes).toContain('overflow-y-auto')
  })

  it('keeps the system menu for an input inside a shadow root in the popup', () => {
    render(<MessageBubble {...props()} />)
    fireEvent.contextMenu(screen.getByText('Hello, world!'))
    const host = document.createElement('div')
    menu()!.appendChild(host)
    const input = document.createElement('input')
    host.attachShadow({ mode: 'open' }).appendChild(input)
    expect(fireEvent.contextMenu(input, { composed: true })).toBe(true)
  })
})
