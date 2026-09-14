import { confirmedRoomMessage } from '@/test-utils/roomMessages'
import type { RoomMessage } from '@fluux/sdk'
/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessageSelection } from './useMessageSelection'
import { messageRowId } from '@/components/conversation/messageRowIdentity'

interface MockMessage {
  id: string
  body: string
  occupantId?: string
}

describe('useMessageSelection', () => {
  const createMessages = (count: number): MockMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `msg-${i}`,
      body: `Message ${i}`,
    }))

  let mockScrollRef: { current: HTMLDivElement | null }
  let mockIsAtBottomRef: { current: boolean }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('CSS', { escape: (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') })
    mockScrollRef = { current: null }
    mockIsAtBottomRef = { current: true }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('initial state', () => {
    it('should return all required properties', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      expect(result.current.selectedMessageId).toBe(null)
      expect(result.current.hasKeyboardSelection).toBe(false)
      expect(result.current.showToolbarForSelection).toBe(false)
      expect(result.current.handleKeyDown).toBeDefined()
      expect(result.current.clearSelection).toBeDefined()
      expect(result.current.handleMouseMove).toBeDefined()
      expect(result.current.handleMouseLeave).toBeDefined()
    })
  })

  it('navigates occupant-conflicting rows independently', () => {
    const messages: MockMessage[] = [
      { id: 'shared', occupantId: 'occupant-a', body: 'first' },
      { id: 'shared', occupantId: 'occupant-b', body: 'second' },
    ]
    const onEnterPressed = vi.fn()
    const { result } = renderHook(() =>
      useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, {
        getRowId: (message) => `${message.id}:${message.occupantId}`,
        onEnterPressed,
      })
    )

    act(() => {
      result.current.handleKeyDown({
        key: 'ArrowUp',
        altKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent)
    })
    expect(result.current.selectedMessageId).toBe('shared:occupant-b')

    act(() => {
      result.current.handleKeyDown({
        key: 'ArrowUp',
        altKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent)
    })
    expect(result.current.selectedMessageId).toBe('shared:occupant-a')

    act(() => {
      result.current.handleKeyDown({ key: 'Enter', preventDefault: vi.fn() } as unknown as React.KeyboardEvent)
    })
    expect(onEnterPressed).toHaveBeenCalledWith('shared')
  })

  it('clears a vanished selected row before navigating the remaining rows', () => {
    const visible = { id: 'shared', occupantId: 'visible', body: 'Kept message' }
    const removed = { id: 'shared', occupantId: 'removed', body: 'Spam' }
    const onReachedFirstMessage = vi.fn()
    const { result, rerender } = renderHook(({ messages }: { messages: MockMessage[] }) =>
      useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, {
        getRowId: message => `${message.id}:${message.occupantId}`,
        onReachedFirstMessage,
      }), { initialProps: { messages: [visible, removed] } }
    )
    act(() => result.current.setSelectedMessageId('shared:removed'))
    act(() => vi.advanceTimersByTime(400))
    expect(result.current.showToolbarForSelection).toBe(true)

    rerender({ messages: [visible] })
    expect(result.current.selectedMessageId).toBeNull()
    expect(result.current.hasKeyboardSelection).toBe(false)
    expect(result.current.showToolbarForSelection).toBe(false)
    act(() => result.current.handleKeyDown({
      key: 'ArrowUp', preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as React.KeyboardEvent))
    expect(result.current.selectedMessageId).toBe('shared:visible')
    expect(onReachedFirstMessage).not.toHaveBeenCalled()
  })

  it('releases Enter when the selected row disappears from an empty window', () => {
    const messages = createMessages(1)
    const onEnterPressed = vi.fn()
    const { result, rerender } = renderHook(({ rows }: { rows: MockMessage[] }) =>
      useMessageSelection(rows, mockScrollRef, mockIsAtBottomRef, { onEnterPressed }),
    { initialProps: { rows: messages } })
    act(() => result.current.setSelectedMessageId(messages[0].id))
    rerender({ rows: [] })

    const preventDefault = vi.fn()
    act(() => result.current.handleKeyDown({
      key: 'Enter', preventDefault, stopPropagation: vi.fn(),
    } as unknown as React.KeyboardEvent))
    expect(preventDefault).not.toHaveBeenCalled()
    expect(onEnterPressed).not.toHaveBeenCalled()
    expect(result.current.selectedMessageId).toBeNull()
    rerender({ rows: messages })
    expect(result.current.selectedMessageId).toBeNull()
  })

  it.each(['legacy', 'confirmed'])('clears the selected %s row when identical raw IDs survive', selected => {
    const first: RoomMessage = { type: 'groupchat', roomJid: 'room@example.com', from: 'room@example.com/Peer', nick: 'Peer',
      id: 'shared', occupantId: 'peer', stanzaId: 'same', body: 'Uncertain', timestamp: new Date(1000), isOutgoing: false }
    const second = confirmedRoomMessage({ ...first, body: 'Confirmed', timestamp: new Date(2000) })
    const removed = selected === 'legacy' ? first : second
    const survivor = selected === 'legacy' ? second : first
    const { result, rerender } = renderHook(({ messages }) =>
      useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, { getRowId: messageRowId }),
    { initialProps: { messages: [first, second] } })
    act(() => result.current.setSelectedMessageId(messageRowId(removed)!))
    act(() => vi.advanceTimersByTime(400))
    expect(result.current.showToolbarForSelection).toBe(true)
    rerender({ messages: [survivor] })
    expect(result.current.selectedMessageId).toBeNull()
    expect(result.current.hasKeyboardSelection).toBe(false)
    expect(result.current.showToolbarForSelection).toBe(false)
  })

  it.each([undefined, 'first-archive'])('clears a removed row with archive %s when a colliding row survives', stanzaId => {
    const first = { id: 'shared', occupantId: 'peer', stanzaId, body: 'Removed' }
    const second = { ...first, stanzaId: 'second-archive', body: 'Kept' }
    const { result, rerender } = renderHook(({ messages }) =>
      useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, { getRowId: messageRowId }),
    { initialProps: { messages: [first, second] } })
    act(() => result.current.setSelectedMessageId(messageRowId(first)!))
    act(() => vi.advanceTimersByTime(400))
    expect(result.current.showToolbarForSelection).toBe(true)
    rerender({ messages: [second] })
    expect(result.current.selectedMessageId).toBeNull()
    expect(result.current.hasKeyboardSelection).toBe(false)
    expect(result.current.showToolbarForSelection).toBe(false)
  })

  it.each([undefined, 'foreign-legacy'])('retains a selected row after validated confirmation of %s', stanzaId => {
    const original = { id: 'message', occupantId: 'peer', stanzaId, body: 'Kept' }
    const confirmed = { ...original, stanzaId: 'archive', localRowRef: { id: original.id, occupantId: original.occupantId, stanzaId } }
    const { result, rerender } = renderHook(({ messages }) =>
      useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, { getRowId: messageRowId }),
    { initialProps: { messages: [original] } })
    act(() => result.current.setSelectedMessageId(messageRowId(original)!))
    rerender({ messages: [confirmed] })
    expect(result.current.selectedMessageId).toBe(messageRowId(confirmed))
    expect(result.current.hasKeyboardSelection).toBe(true)
  })

  it('keeps the room-switch reset callback stable while selecting a row', () => {
    const messages = createMessages(2)
    const { result } = renderHook(() => useMessageSelection(messages, mockScrollRef))
    const clearSelection = result.current.clearSelection
    act(() => result.current.setSelectedMessageId(messages[0].id))
    expect(result.current.selectedMessageId).toBe(messages[0].id)
    expect(result.current.clearSelection).toBe(clearSelection)
  })

  describe('clearSelection', () => {
    it('should reset selection state', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set a selection
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      expect(result.current.selectedMessageId).toBe('msg-2')
      expect(result.current.hasKeyboardSelection).toBe(true)

      // Clear selection
      act(() => {
        result.current.clearSelection()
      })

      expect(result.current.selectedMessageId).toBe(null)
      expect(result.current.hasKeyboardSelection).toBe(false)
      expect(result.current.showToolbarForSelection).toBe(false)
    })
  })

  // Keyboard selection moves the highlight without moving DOM focus, so the
  // hook scrolls the selected row into view explicitly.
  describe('scroll-into-view on selection', () => {
    it('scrolls the selected row into view', () => {
      const scrollIntoView = vi.fn()
      Element.prototype.scrollIntoView = scrollIntoView

      const ids = ['msg-0', 'msg-1', 'msg-2']
      const els = ids.map((id) => {
        const el = document.createElement('div')
        el.className = 'message-row'
        el.setAttribute('data-message-id', id)
        document.body.appendChild(el)
        return el
      })

      const messages = createMessages(3)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-1')
      })
      expect(scrollIntoView).toHaveBeenCalled()

      els.forEach((el) => el.remove())
    })
  })

  describe('DOM selection identity', () => {
    let container: HTMLDivElement

    const appendRow = (message: MockMessage & { stanzaId?: string }, top: number) => {
      const element = document.createElement('div')
      element.dataset.messageId = message.id
      element.dataset.messageRowId = messageRowId(message)
      element.getBoundingClientRect = () => ({ top, bottom: top + 20 } as DOMRect)
      element.scrollIntoView = vi.fn()
      container.appendChild(element)
      return element
    }
    const keyEvent = (key: string) => ({
      key, preventDefault: vi.fn(), stopPropagation: vi.fn(),
    } as unknown as React.KeyboardEvent)

    beforeEach(() => {
      container = document.createElement('div')
      container.getBoundingClientRect = () => ({ top: 0, bottom: 100 } as DOMRect)
      document.body.appendChild(container)
      mockScrollRef.current = container
    })

    afterEach(() => container.remove())

    describe.each(['default', 'undefined fallback'] as const)('%s literal IDs', mode => {
      const getRowId = mode === 'default' ? undefined : () => undefined
      const cases = [
        { id: 'client-row:"wire"', decoy: { id: 'wire', body: 'Decoy' } },
        { id: 'occupant-row:["wire","peer"]', decoy: { id: 'wire', occupantId: 'peer', body: 'Decoy' } },
        { id: 'archive-row:["wire","peer","archive"]', decoy: { id: 'wire', occupantId: 'peer', stanzaId: 'archive', body: 'Decoy' } },
      ]

      it.each(cases)('scrolls $id without selecting its decoded decoy or scrolling again on arrival', ({ id, decoy }) => {
        const literal = { id, body: 'Literal' }
        const decoyElement = appendRow(decoy, -80)
        const literalElement = appendRow(literal, 20)
        const onEnterPressed = vi.fn()
        const { result, rerender } = renderHook(({ messages }) =>
          useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, { getRowId, onEnterPressed }),
        { initialProps: { messages: [decoy, literal] } })
        const clearSelection = result.current.clearSelection

        act(() => result.current.setSelectedMessageId(id))
        expect(result.current.selectedMessageId).toBe(id)
        expect(literalElement.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' })
        expect(decoyElement.scrollIntoView).not.toHaveBeenCalled()
        act(() => result.current.handleKeyDown(keyEvent('Enter')))
        expect(onEnterPressed).toHaveBeenCalledExactlyOnceWith(id)

        rerender({ messages: [decoy, literal, { id: 'arrival', body: 'New message' }] })
        act(() => vi.advanceTimersByTime(400))
        expect(result.current.selectedMessageId).toBe(id)
        expect(result.current.clearSelection).toBe(clearSelection)
        expect(literalElement.scrollIntoView).toHaveBeenCalledTimes(1)
        expect(decoyElement.scrollIntoView).not.toHaveBeenCalled()
      })

      it.each(cases)('starts keyboard selection at visible literal $id with its decoy offscreen', ({ id, decoy }) => {
        const literal = { id, body: 'Literal' }
        const tail = { id: 'tail', body: 'Offscreen tail' }
        const decoyElement = appendRow(decoy, -80)
        const literalElement = appendRow(literal, 20)
        const tailElement = appendRow(tail, 200)
        const { result } = renderHook(() =>
          useMessageSelection([decoy, literal, tail], mockScrollRef, mockIsAtBottomRef, { getRowId }))

        act(() => result.current.handleKeyDown(keyEvent('ArrowUp')))
        expect(result.current.selectedMessageId).toBe(id)
        expect(literalElement.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' })
        expect(decoyElement.scrollIntoView).not.toHaveBeenCalled()
        expect(tailElement.scrollIntoView).not.toHaveBeenCalled()
      })
    })

    it('uses custom room handles for visibility and scrolling while Enter receives the message ID', () => {
      const visible = { id: 'shared', occupantId: 'first', body: 'Visible' }
      const offscreen = { id: 'shared', occupantId: 'second', body: 'Offscreen' }
      const visibleElement = appendRow(visible, 20)
      const offscreenElement = appendRow(offscreen, 200)
      const onEnterPressed = vi.fn()
      const { result, rerender } = renderHook(({ messages }) =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, {
          getRowId: message => messageRowId(message), onEnterPressed,
        }), { initialProps: { messages: [visible, offscreen] } })

      act(() => result.current.handleKeyDown(keyEvent('ArrowUp')))
      expect(result.current.selectedMessageId).toBe(messageRowId(visible))
      expect(visibleElement.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' })
      expect(offscreenElement.scrollIntoView).not.toHaveBeenCalled()
      rerender({ messages: [visible, offscreen, { ...offscreen, id: 'arrival' }] })
      expect(visibleElement.scrollIntoView).toHaveBeenCalledTimes(1)

      act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
      expect(result.current.selectedMessageId).toBe(messageRowId(offscreen))
      expect(offscreenElement.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' })
      act(() => result.current.handleKeyDown(keyEvent('Enter')))
      expect(onEnterPressed).toHaveBeenCalledExactlyOnceWith('shared')
    })
  })

  describe('toolbar debounce', () => {
    it('should hide toolbar immediately on selection change', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set initial selection
      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      // Wait for toolbar to appear
      act(() => {
        vi.advanceTimersByTime(400)
      })

      expect(result.current.showToolbarForSelection).toBe(true)

      // Change selection - toolbar should hide immediately
      act(() => {
        result.current.setSelectedMessageId('msg-1')
      })

      expect(result.current.showToolbarForSelection).toBe(false)
    })

    it('should show toolbar after 400ms of settling', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      // Initially hidden
      expect(result.current.showToolbarForSelection).toBe(false)

      // After 200ms - still hidden
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(result.current.showToolbarForSelection).toBe(false)

      // After 400ms - visible
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(result.current.showToolbarForSelection).toBe(true)
    })

    it('should hide toolbar when selection is cleared', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set selection
      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      // Wait for toolbar to show
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(result.current.showToolbarForSelection).toBe(true)

      // Clear selection
      act(() => {
        result.current.setSelectedMessageId(null)
      })
      expect(result.current.showToolbarForSelection).toBe(false)
    })
  })


  describe('handleMouseMove', () => {
    it('should clear keyboard selection when mouse moves significantly', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set selection
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })
      expect(result.current.hasKeyboardSelection).toBe(true)

      // First mouse move to establish position
      act(() => {
        result.current.handleMouseMove({
          clientX: 100,
          clientY: 100,
        } as React.MouseEvent, 'msg-1')
      })

      // Second mouse move with significant movement - should clear selection
      act(() => {
        result.current.handleMouseMove({
          clientX: 200,
          clientY: 200,
        } as React.MouseEvent, 'msg-3')
      })

      expect(result.current.hasKeyboardSelection).toBe(false)
    })

    it('should not clear selection during keyboard cooldown', () => {
      vi.useRealTimers() // Use real timers for this test
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set selection and simulate keyboard navigation (which sets cooldown)
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Manually trigger keyboard handler to set cooldown
      act(() => {
        const event = {
          key: 'ArrowUp',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // Mouse move during cooldown - should NOT clear selection
      act(() => {
        result.current.handleMouseMove({
          clientX: 100,
          clientY: 100,
        } as React.MouseEvent, 'msg-1')
      })

      expect(result.current.hasKeyboardSelection).toBe(true)
      vi.useFakeTimers() // Restore fake timers
    })
  })

  describe('setSelectedMessageId', () => {
    it('should update selection state', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-3')
      })

      expect(result.current.selectedMessageId).toBe('msg-3')
      expect(result.current.hasKeyboardSelection).toBe(true)
    })
  })

  describe('hasKeyboardSelection', () => {
    it('should be true when message is selected', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      expect(result.current.hasKeyboardSelection).toBe(false)

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      expect(result.current.hasKeyboardSelection).toBe(true)
    })

    it('should be false when selection is null', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })
      expect(result.current.hasKeyboardSelection).toBe(true)

      act(() => {
        result.current.setSelectedMessageId(null)
      })
      expect(result.current.hasKeyboardSelection).toBe(false)
    })
  })

  describe('messages update', () => {
    it('should keep selection when messages array changes', () => {
      const initialMessages = createMessages(5)
      const { result, rerender } = renderHook(
        ({ msgs }) => useMessageSelection(msgs, mockScrollRef, mockIsAtBottomRef),
        { initialProps: { msgs: initialMessages } }
      )

      // Select a message
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })
      expect(result.current.selectedMessageId).toBe('msg-2')

      // Add more messages
      const newMessages = [...initialMessages, { id: 'msg-5', body: 'New message' }]
      rerender({ msgs: newMessages })

      // Selection should be preserved
      expect(result.current.selectedMessageId).toBe('msg-2')
    })
  })

  describe('handleKeyDown with arrow keys', () => {
    it('should navigate up with ArrowUp', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Select msg-2 (middle)
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // ArrowUp should move selection up
      act(() => {
        const event = {
          key: 'ArrowUp',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe('msg-1')
    })

    it('should navigate down with ArrowDown', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Select msg-2 (middle)
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // ArrowDown should move selection down
      act(() => {
        const event = {
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe('msg-3')
    })

    it('should start navigation from hovered message', () => {
      vi.useRealTimers() // Use real timers for cooldown
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // No selection initially
      expect(result.current.selectedMessageId).toBe(null)

      // Hover over msg-3 (mouse move with significant movement)
      act(() => {
        result.current.handleMouseMove({
          clientX: 100,
          clientY: 100,
        } as React.MouseEvent, 'msg-3')
      })

      // Press ArrowUp to start keyboard navigation from hovered message
      act(() => {
        const event = {
          key: 'ArrowUp',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // First ArrowUp should select the hovered message (msg-3)
      expect(result.current.selectedMessageId).toBe('msg-3')

      vi.useFakeTimers() // Restore fake timers
    })

    it('should ignore Alt+Arrow to let sidebar handle it', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Select msg-2 (middle)
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Alt+ArrowUp should be ignored (passes through to sidebar)
      act(() => {
        const event = {
          key: 'ArrowUp',
          altKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // Selection should remain unchanged
      expect(result.current.selectedMessageId).toBe('msg-2')
    })

    it('should not navigate with unrelated keys', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Tab should not navigate
      act(() => {
        const event = {
          key: 'Tab',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe('msg-2')
    })

    it('should call onEnterPressed when Enter is pressed on a selected message', () => {
      const messages = createMessages(5)
      const onEnterPressed = vi.fn()
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, {
          onEnterPressed,
        })
      )

      // Select a message
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Press Enter
      const preventDefault = vi.fn()
      act(() => {
        const event = {
          key: 'Enter',
          preventDefault,
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // onEnterPressed should be called with the message ID
      expect(onEnterPressed).toHaveBeenCalledWith('msg-2')
      expect(preventDefault).toHaveBeenCalled()
      // Selection should remain
      expect(result.current.selectedMessageId).toBe('msg-2')
    })

    it('should not call onEnterPressed when no message is selected', () => {
      const messages = createMessages(5)
      const onEnterPressed = vi.fn()
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, {
          onEnterPressed,
        })
      )

      // No selection
      expect(result.current.selectedMessageId).toBe(null)

      // Press Enter
      act(() => {
        const event = {
          key: 'Enter',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // onEnterPressed should NOT be called
      expect(onEnterPressed).not.toHaveBeenCalled()
    })

    it('should not call anything when Enter is pressed without onEnterPressed callback', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Select a message
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Press Enter - should not throw or change selection
      act(() => {
        const event = {
          key: 'Enter',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // Selection should remain unchanged
      expect(result.current.selectedMessageId).toBe('msg-2')
    })

    it('loads history from an empty window only on ArrowUp with a cooldown', () => {
      const onReachedFirstMessage = vi.fn()
      const { result, rerender } = renderHook(() =>
        useMessageSelection([], mockScrollRef, mockIsAtBottomRef, { onReachedFirstMessage })
      )
      const pressKey = (key: string, altKey = false) => {
        const event = { key, altKey, preventDefault: vi.fn(), stopPropagation: vi.fn() }
        act(() => result.current.handleKeyDown(event as unknown as React.KeyboardEvent))
        return event
      }

      expect(onReachedFirstMessage).not.toHaveBeenCalled()
      pressKey('ArrowDown')
      pressKey('ArrowUp', true)
      expect(onReachedFirstMessage).not.toHaveBeenCalled()
      const request = pressKey('ArrowUp')
      expect(onReachedFirstMessage).toHaveBeenCalledTimes(1)
      expect(request.preventDefault).toHaveBeenCalled()
      expect(request.stopPropagation).toHaveBeenCalled()
      expect(result.current.selectedMessageId).toBeNull()

      rerender()
      pressKey('ArrowUp')
      expect(onReachedFirstMessage).toHaveBeenCalledTimes(1)
      act(() => vi.advanceTimersByTime(1001))
      expect(onReachedFirstMessage).toHaveBeenCalledTimes(1)
      pressKey('ArrowUp')
      expect(onReachedFirstMessage).toHaveBeenCalledTimes(2)
    })

    it.each([
      { isLoadingOlder: true, isHistoryComplete: false },
      { isLoadingOlder: false, isHistoryComplete: true },
    ])('does not request empty-window history while %j', historyState => {
      const onReachedFirstMessage = vi.fn()
      const { result } = renderHook(() =>
        useMessageSelection([], mockScrollRef, mockIsAtBottomRef, {
          ...historyState, onReachedFirstMessage,
        })
      )
      act(() => result.current.handleKeyDown({
        key: 'ArrowUp', preventDefault: vi.fn(), stopPropagation: vi.fn(),
      } as unknown as React.KeyboardEvent))

      expect(onReachedFirstMessage).not.toHaveBeenCalled()
      expect(result.current.selectedMessageId).toBeNull()
    })

    it('should do nothing when messages array is empty', () => {
      const { result } = renderHook(() =>
        useMessageSelection([], mockScrollRef, mockIsAtBottomRef)
      )

      const preventDefault = vi.fn()
      const stopPropagation = vi.fn()

      act(() => {
        const event = {
          key: 'ArrowUp',
          preventDefault,
          stopPropagation,
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe(null)
      // preventDefault should not be called when messages are empty
      expect(preventDefault).not.toHaveBeenCalled()
    })
  })
})
