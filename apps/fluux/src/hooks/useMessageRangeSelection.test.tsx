import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessageRangeSelection } from './useMessageRangeSelection'
import { useToastStore } from '@/stores/toastStore'

// Deterministic i18n: return the key (or interpolate num) without app i18n init.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { num?: number }) => (o?.num !== undefined ? `${o.num} selected` : k) }),
}))

const MESSAGES = [
  { id: 'a', from: 'Alice', time: '10:00', body: 'one', date: '2024-01-15' },
  { id: 'b', from: 'Bob', time: '10:01', body: 'two', date: '2024-01-15' },
  { id: 'c', from: 'Alice', time: '10:02', body: 'three', date: '2024-01-15' },
]
const fmt = (m: (typeof MESSAGES)[number]) => ({ id: m.id, from: m.from, time: m.time, body: m.body, date: m.date })

let container: HTMLDivElement
let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  container.className = 'focus-zone'
  container.tabIndex = -1
  // Rows the delegated mousedown resolves against.
  for (const m of MESSAGES) {
    const row = document.createElement('div')
    row.setAttribute('data-message-id', m.id)
    container.appendChild(row)
  }
  document.body.appendChild(container)
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  // The hook calls window.getSelection()?.removeAllRanges() on select-all / shift-extend.
  vi.spyOn(window, 'getSelection').mockReturnValue({ removeAllRanges: () => {} } as unknown as Selection)
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  container.remove()
  vi.restoreAllMocks()
})

function setup() {
  const containerRef = { current: container } as React.RefObject<HTMLElement>
  return renderHook(() =>
    useMessageRangeSelection({ containerRef, messages: MESSAGES, formatForCopy: fmt, conversationId: 'c1' }),
  )
}

describe('useMessageRangeSelection', () => {
  it('selectAll selects every loaded message', () => {
    const { result } = setup()
    act(() => result.current.selectAll())
    expect(result.current.selectionCount).toBe(3)
    expect([...result.current.copySelectedIds]).toEqual(['a', 'b', 'c'])
    expect(result.current.isSelecting).toBe(true)
  })

  it('extendTo builds a contiguous range from the first extend point', () => {
    const { result } = setup()
    act(() => result.current.extendTo('b'))
    act(() => result.current.extendTo('c'))
    expect([...result.current.copySelectedIds]).toEqual(['b', 'c'])
  })

  it('Cmd+A keydown selects all when focus is within the list', () => {
    const { result } = setup()
    container.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    })
    expect(result.current.selectionCount).toBe(3)
  })

  it('Shift+mousedown on a row extends the range', () => {
    const { result } = setup()
    act(() => result.current.extendTo('a'))
    act(() => {
      container
        .querySelector('[data-message-id="c"]')!
        .dispatchEvent(new MouseEvent('mousedown', { shiftKey: true, bubbles: true }))
    })
    expect([...result.current.copySelectedIds]).toEqual(['a', 'b', 'c'])
  })

  it('copySelected writes buildCopyText output and shows a toast', async () => {
    const { result } = setup()
    act(() => result.current.selectAll())
    await act(async () => {
      result.current.copySelected()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toBe(
      ['— Monday, January 15, 2024 —', 'Alice 10:00', 'one', 'Bob 10:01', 'two', 'Alice 10:02', 'three'].join('\n'),
    )
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('chat.selection.copied')
  })

  it('clearSelection resets', () => {
    const { result } = setup()
    act(() => result.current.selectAll())
    act(() => result.current.clearSelection())
    expect(result.current.isSelecting).toBe(false)
    expect(result.current.selectionCount).toBe(0)
  })
})
