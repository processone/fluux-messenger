/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useToastStore } from '@/stores/toastStore'
import { JumpToDateDialog } from './JumpToDateDialog'
import { localDayBounds, localDayValue } from '@fluux/sdk'

const h = vi.hoisted(() => ({ find: vi.fn(), messages: {} }))
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useXMPPContext: () => ({ client: { messages: h.messages } }),
  findFirstMessageOfDay: h.find,
}))

const PEER = 'alice@example.com'
const message = (timestamp: Date) => ({ type: 'chat', id: 'm1', conversationId: PEER, from: PEER, body: 'hi', timestamp, isOutgoing: false })

function open(loaded: ReturnType<typeof message>[] = [], initialDay?: string, archiveAvailable?: boolean, windowAtLiveEdge = true) {
  const onLand = vi.fn()
  const onRecenterToLatest = vi.fn()
  const onClose = vi.fn()
  render(<JumpToDateDialog kind={archiveAvailable === false ? 'room' : 'chat'} conversationId={PEER} initialDay={initialDay} archiveAvailable={archiveAvailable} windowAtLiveEdge={windowAtLiveEdge} onRecenterToLatest={onRecenterToLatest} readLoaded={() => loaded as never} onLand={onLand} onClose={onClose} />)
  return { onLand, onRecenterToLatest, onClose }
}

async function go(day: string) {
  fireEvent.change(screen.getByLabelText('chat.jumpToDate.date'), { target: { value: day } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.go' })) })
}

// Intent: the reader picks a day in their own time zone and lands on its first message,
// or is told plainly when the conversation holds nothing there.
describe('JumpToDateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
  })

  it('bounds a day by the local midnights around it', () => {
    expect(localDayBounds('2024-03-10')).toEqual({ start: new Date(2024, 2, 10), end: new Date(2024, 2, 11) })
    expect(localDayBounds('03/10/2024')).toBeNull()
    expect(localDayValue(new Date(2024, 0, 5, 23, 59))).toBe('2024-01-05')
  })

  it('lands on the first message of the day and closes', async () => {
    h.find.mockResolvedValue({ kind: 'found', message: message(new Date(2024, 2, 10, 8)), source: 'archive' })
    const { onLand, onClose } = open()
    await go('2024-03-10')
    expect(h.find).toHaveBeenCalledWith(h.messages, 'chat', PEER, new Date(2024, 2, 10), new Date(2024, 2, 11), [], undefined)
    expect(onLand).toHaveBeenCalledWith('m1')
    expect(onClose).toHaveBeenCalled()
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('says so when it lands on a later day', async () => {
    h.find.mockResolvedValue({ kind: 'found', message: message(new Date(2024, 2, 12, 8)), source: 'archive' })
    const { onLand } = open()
    await go('2024-03-10')
    expect(onLand).toHaveBeenCalledWith('m1')
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'info', message: 'chat.jumpToDate.showingLater' })])
  })

  it.each([['none'], ['unknown']])('stays open with an error when the answer is %s', async (kind) => {
    h.find.mockResolvedValue({ kind })
    const { onLand, onClose } = open()
    await go('2024-03-10')
    expect(screen.getByRole('alert').textContent).toBe(kind === 'none' ? 'chat.jumpToDate.none' : 'chat.jumpToDate.failed')
    expect(onLand).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('refuses a day in the future without asking', async () => {
    open()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    await go(localDayValue(tomorrow))
    // The input's max blocks the submit, as a browser does
    expect(h.find).not.toHaveBeenCalled()
  })

  it('jumps a week back from a preset', async () => {
    h.find.mockResolvedValue({ kind: 'found', message: message(new Date()), source: 'cache' })
    const { onLand } = open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.weekAgo' })) })
    const now = new Date()
    expect(h.find.mock.calls[0][3]).toEqual(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7))
    expect(onLand).toHaveBeenCalled()
  })

  it.each([
    ['monthAgo', new Date(2026, 2, 31, 12), new Date(2026, 1, 28)],
    ['yearAgo', new Date(2024, 1, 29, 12), new Date(2023, 1, 28)],
  ])('clamps the %s preset to the last day of the target month', async (shortcut, today, target) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(today)
      h.find.mockResolvedValue({ kind: 'found', message: message(target), source: 'cache' })
      open()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: `chat.jumpToDate.${shortcut}` })) })
      expect(h.find.mock.calls[0][3]).toEqual(target)
    } finally { vi.useRealTimers() }
  })

  it('does not offer the archive to the lookup when the room has no archive', async () => {
    h.find.mockResolvedValue({ kind: 'none' })
    open([], undefined, false)
    await go('2024-03-10')
    expect(h.find.mock.calls[0][0]).toBeUndefined()
  })

  it('recenters to latest instead of landing on a parked window when nothing comes after the day', async () => {
    h.find.mockResolvedValue({ kind: 'none' })
    const stale = { ...message(new Date(2024, 2, 9, 20)), id: 'stale-window-last' }
    const { onLand, onRecenterToLatest } = open([message(new Date(2024, 2, 9, 8)), stale], undefined, undefined, false)
    await go('2024-03-10')
    expect(onRecenterToLatest).toHaveBeenCalledOnce()
    expect(onLand).not.toHaveBeenCalled()
  })

  it('lands on the latest loaded message when nothing comes after the day', async () => {
    h.find.mockResolvedValue({ kind: 'none' })
    const latest = { ...message(new Date(2024, 2, 9, 20)), id: 'latest' }
    const { onLand, onClose } = open([message(new Date(2024, 2, 9, 8)), latest])
    await go('2024-03-10')
    expect(h.find.mock.calls[0][5]).toHaveLength(2)
    expect(onLand).toHaveBeenCalledWith('latest')
    expect(onClose).toHaveBeenCalled()
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'info', message: 'chat.jumpToDate.showingLatest' })])
  })

  // Approved day-pill plan: opening and Tab traversal stay inside the named picker.
  it('names the dialog, focuses the date and keeps forward/backward Tab inside', () => {
    open()
    const dialog = screen.getByRole('dialog', { name: 'chat.jumpToDate.title' })
    const input = screen.getByLabelText('chat.jumpToDate.date')
    expect(input).toHaveFocus()
    const last = screen.getByRole('button', { name: 'chat.jumpToDate.yearAgo' })
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(input).toHaveFocus()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(h.find).not.toHaveBeenCalled()
  })

  it('opens on the day of the date bubble it came from', () => {
    open([], '2024-03-10')
    expect((screen.getByLabelText('chat.jumpToDate.date') as HTMLInputElement).value).toBe('2024-03-10')
  })

  // Approved picker contract: pending lookups retain keyboard focus and submit only once.
  it('keeps the pending input and Go stop usable until an archive error', async () => {
    let resolve!: (result: unknown) => void
    h.find.mockReturnValueOnce(new Promise(done => { resolve = done }))
    open([], '2024-03-10')
    const input = screen.getByLabelText('chat.jumpToDate.date')
    fireEvent.submit(input.closest('form')!)
    expect(input).toHaveFocus()
    expect(input).not.toBeDisabled()
    expect(input).toHaveAttribute('readonly')
    const go = screen.getByRole('button', { name: 'chat.jumpToDate.searching' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(go).toHaveFocus()
    fireEvent.click(go)
    fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.weekAgo' }))
    expect(h.find).toHaveBeenCalledTimes(1)
    await act(async () => resolve({ kind: 'unknown' }))
    expect(go).toHaveFocus()
    expect(screen.getByRole('alert')).toHaveTextContent('chat.jumpToDate.failed')
  })

  // Approved Escape cancellation must take effect before the exit animation finishes.
  it.each(['Escape', 'Close', 'backdrop'])('cancels a pending lookup immediately on %s', async route => {
    let resolve!: (result: unknown) => void
    h.find.mockReturnValueOnce(new Promise(done => { resolve = done }))
    document.documentElement.setAttribute('data-motion', 'full')
    vi.useFakeTimers()
    try {
      const { onLand, onClose } = open([], '2024-03-10')
      fireEvent.submit(screen.getByLabelText('chat.jumpToDate.date').closest('form')!)
      if (route === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
      else if (route === 'Close') fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
      else fireEvent.click(document.querySelector('[data-modal] > button')!)
      expect(onClose).not.toHaveBeenCalled()
      await act(async () => resolve({ kind: 'found', message: message(new Date(2024, 2, 10, 8)), source: 'archive' }))
      expect(onLand).not.toHaveBeenCalled()
      act(() => vi.runOnlyPendingTimers())
      expect(onClose).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      document.documentElement.removeAttribute('data-motion')
    }
  })
})
