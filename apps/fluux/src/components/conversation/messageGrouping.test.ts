import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { groupMessagesByDate, shouldShowAvatar, scrollToMessage, isActionMessage } from './messageGrouping'

// Mock CSS.escape since it's not available in JSDOM
// This implementation matches the browser's CSS.escape behavior
vi.stubGlobal('CSS', {
  escape: (str: string) => str.replace(/([/@+=])/g, '\\$1'),
})

describe('groupMessagesByDate', () => {
  it('should group messages by date', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T11:00:00'), from: 'bob' },
      { id: '3', timestamp: new Date('2024-01-16T09:00:00'), from: 'alice' },
    ]

    const groups = groupMessagesByDate(messages)

    expect(groups).toHaveLength(2)
    expect(groups[0].date).toBe('2024-01-15')
    expect(groups[0].messages).toHaveLength(2)
    expect(groups[1].date).toBe('2024-01-16')
    expect(groups[1].messages).toHaveLength(1)
  })

  it('should return empty array for empty messages', () => {
    const groups = groupMessagesByDate([])
    expect(groups).toHaveLength(0)
  })

  it('should handle single message', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
    ]

    const groups = groupMessagesByDate(messages)

    expect(groups).toHaveLength(1)
    expect(groups[0].date).toBe('2024-01-15')
    expect(groups[0].messages).toHaveLength(1)
  })

  it('should preserve message order within groups', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T11:00:00'), from: 'bob' },
      { id: '3', timestamp: new Date('2024-01-15T12:00:00'), from: 'charlie' },
    ]

    const groups = groupMessagesByDate(messages)

    expect(groups[0].messages[0].id).toBe('1')
    expect(groups[0].messages[1].id).toBe('2')
    expect(groups[0].messages[2].id).toBe('3')
  })

  it('should handle multiple days', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-13T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-14T10:00:00'), from: 'bob' },
      { id: '3', timestamp: new Date('2024-01-15T10:00:00'), from: 'charlie' },
    ]

    const groups = groupMessagesByDate(messages)

    expect(groups).toHaveLength(3)
    expect(groups[0].date).toBe('2024-01-13')
    expect(groups[1].date).toBe('2024-01-14')
    expect(groups[2].date).toBe('2024-01-15')
  })

  /**
   * REGRESSION: Messages can arrive out of chronological order (e.g., delayed messages
   * arriving after newer messages). This creates multiple groups with the same date.
   *
   * MessageList must use `${group.date}-${groupIndex}` as the React key to avoid
   * duplicate key warnings when the same date appears in multiple groups.
   */
  it('should consolidate out-of-order messages from same date into single group', () => {
    // Simulate delayed message scenario:
    // 1. Messages from Jan 23 arrive
    // 2. Messages from Jan 24 arrive
    // 3. A delayed message from Jan 23 arrives late (out of order in array)
    const messages = [
      { id: '1', timestamp: new Date('2024-01-23T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-24T09:00:00'), from: 'bob' },
      { id: '3', timestamp: new Date('2024-01-23T11:00:00'), from: 'charlie' }, // Out of order
    ]

    const groups = groupMessagesByDate(messages)

    // Now consolidates into 2 groups (one per date), sorted chronologically
    expect(groups).toHaveLength(2)
    expect(groups[0].date).toBe('2024-01-23')
    expect(groups[1].date).toBe('2024-01-24')

    // Jan 23 group contains both messages, sorted by timestamp
    expect(groups[0].messages).toHaveLength(2)
    expect(groups[0].messages[0].id).toBe('1') // 10:00
    expect(groups[0].messages[1].id).toBe('3') // 11:00

    // Jan 24 group contains its message
    expect(groups[1].messages).toHaveLength(1)
    expect(groups[1].messages[0].id).toBe('2')
  })
})

describe('shouldShowAvatar', () => {
  it('should always show avatar for first message', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 0)).toBe(true)
  })

  it('should show avatar when sender changes', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'bob' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(true)
  })

  it('should not show avatar for consecutive messages from same sender within 5 minutes', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:02:00'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(false)
  })

  it('should show avatar if more than 5 minutes gap from same sender', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:06:00'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(true)
  })

  it('should show avatar exactly at 5 minute boundary', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:05:01'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(true)
  })

  it('should not show avatar at exactly 5 minutes', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:05:00'), from: 'alice' },
    ]

    expect(shouldShowAvatar(messages, 1)).toBe(false)
  })

  it('should handle multiple messages in sequence', () => {
    const messages = [
      { id: '1', timestamp: new Date('2024-01-15T10:00:00'), from: 'alice' },
      { id: '2', timestamp: new Date('2024-01-15T10:01:00'), from: 'alice' },
      { id: '3', timestamp: new Date('2024-01-15T10:02:00'), from: 'bob' },
      { id: '4', timestamp: new Date('2024-01-15T10:03:00'), from: 'bob' },
      { id: '5', timestamp: new Date('2024-01-15T10:10:00'), from: 'bob' },
    ]

    expect(shouldShowAvatar(messages, 0)).toBe(true)  // first message
    expect(shouldShowAvatar(messages, 1)).toBe(false) // same sender, within 5 min
    expect(shouldShowAvatar(messages, 2)).toBe(true)  // different sender
    expect(shouldShowAvatar(messages, 3)).toBe(false) // same sender, within 5 min
    expect(shouldShowAvatar(messages, 4)).toBe(true)  // same sender, but > 5 min gap
  })
})

describe('scrollToMessage', () => {
  let mockElement: {
    scrollIntoView: ReturnType<typeof vi.fn>
    classList: {
      add: ReturnType<typeof vi.fn>
      remove: ReturnType<typeof vi.fn>
    }
  }
  let querySelectorSpy: ReturnType<typeof vi.spyOn>
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockElement = {
      scrollIntoView: vi.fn(),
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    }
    querySelectorSpy = vi.spyOn(document, 'querySelector')
    vi.spyOn(document, 'querySelectorAll').mockReturnValue([] as unknown as NodeListOf<Element>)
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('should scroll to message element and add highlight class', () => {
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    scrollToMessage('msg-123')

    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="msg-123"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    })
    expect(mockElement.classList.add).toHaveBeenCalledWith('message-highlight')
  })

  it('should remove highlight class after 1.5 seconds', () => {
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    scrollToMessage('msg-123')

    // Highlight should not be removed yet
    expect(mockElement.classList.remove).not.toHaveBeenCalled()

    // Advance time by 1.5 seconds
    vi.advanceTimersByTime(1500)

    expect(mockElement.classList.remove).toHaveBeenCalledWith('message-highlight')
  })

  it('should not throw if message element is not found', () => {
    querySelectorSpy.mockReturnValue(null)

    // Should not throw
    expect(() => scrollToMessage('non-existent-id')).not.toThrow()

    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="non-existent-id"]')
    expect(mockElement.scrollIntoView).not.toHaveBeenCalled()
    // Should log warning for debugging
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[scrollToMessage] Message not found in DOM: id="non-existent-id"'
    )
  })

  it('should handle special characters in message ID by escaping them', () => {
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    scrollToMessage('msg-with-special/chars@123')

    // CSS.escape escapes special characters like / and @ with backslashes
    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="msg-with-special\\/chars\\@123"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalled()
  })

  it('should escape base64 encoded message IDs', () => {
    querySelectorSpy.mockReturnValue(mockElement as unknown as Element)

    // Base64 IDs often contain +, /, and = characters
    scrollToMessage('abc+def/ghi=jkl')

    expect(querySelectorSpy).toHaveBeenCalledWith('[data-message-id="abc\\+def\\/ghi\\=jkl"]')
    expect(mockElement.scrollIntoView).toHaveBeenCalled()
  })
})

describe('isActionMessage', () => {
  it('should return true for /me action messages', () => {
    expect(isActionMessage('/me waves hello')).toBe(true)
    expect(isActionMessage('/me is thinking')).toBe(true)
    expect(isActionMessage('/me ')).toBe(true)
  })

  it('should return false for regular messages', () => {
    expect(isActionMessage('Hello world')).toBe(false)
    expect(isActionMessage('This is a test')).toBe(false)
    expect(isActionMessage('')).toBe(false)
  })

  it('should return false for /me without space', () => {
    expect(isActionMessage('/metest')).toBe(false)
    expect(isActionMessage('/me')).toBe(false)
  })

  it('should return false for /me in middle of message', () => {
    expect(isActionMessage('Hello /me there')).toBe(false)
    expect(isActionMessage('test /me action')).toBe(false)
  })

  it('should handle undefined and null gracefully', () => {
    expect(isActionMessage(undefined)).toBe(false)
    // @ts-expect-error - testing null handling
    expect(isActionMessage(null)).toBe(false)
  })
})
