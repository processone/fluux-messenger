import { Profiler } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageRowRef, RoomReader } from '@fluux/sdk'
import { RoomReadBadge, RoomReadSharing } from './RoomReadMarkers'
import { RowLayoutContext } from './conversation/rowLayoutContext'

// Source: the accepted short-line plan. Protocol and identity facts remain
// owned by the SDK tests; this source supplies row subscription transitions.
const room = 'reading@conference.localhost'
const empty: readonly RoomReader[] = []
function source(sharing = true) {
  const listeners = new Set<() => void>()
  let rooms = sharing ? [room] : []
  const badges = new Map<string, readonly RoomReader[]>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    isEnabledFor: (jid: string) => rooms.includes(jid),
    setRoomEnabled: (jid: string, enabled: boolean) => {
      rooms = [...rooms.filter(value => value !== jid), ...(enabled ? [jid] : [])]; notify(); return true
    },
    readers: (_room: string, row: MessageRowRef) => badges.get(row.id) ?? empty,
    setReaders: (rows: Record<string, readonly RoomReader[]>) => { for (const [row, readers] of Object.entries(rows)) badges.set(row, readers); notify() },
  }
}

const people: readonly RoomReader[] = [
  { occupantId: 'jules-id', nick: 'Jules' }, { occupantId: 'maya-id', nick: 'Maya' },
  { occupantId: 'noor-id', nick: 'Noor' }, { occupantId: 'sam-id', nick: 'Sam' },
]

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en', dir: () => 'ltr' }, t: (key: string, values?: { names?: string; count?: number }) => {
  const labels: Record<string, string> = {
    'readMarkers.shareInRoom': 'Share my read position in this room',
    'readMarkers.readThrough': 'Read through this message',
    'readMarkers.saveFailed': 'Could not save this choice. Sharing stays off.',
    'readMarkers.readers': `Read through this message: ${values?.names ?? ''}`,
    'readMarkers.readThroughHere': 'Read through here:',
    'readMarkers.others': `+${values?.count} ${values?.count === 1 ? 'other' : 'others'}`,
    'readMarkers.readerCount': `${values?.count} readers`,
  }
  return labels[key] ?? key
} }) }))

describe('room read-marker controls', () => {
  // Source: the approved one-switch contract. SDK tests own persistence and migration.
  it('uses one off-by-default room switch to opt in and out', () => {
    const markers = source(false)
    render(<RoomReadSharing markers={markers} roomJid={room} />)
    const picked = screen.getByRole('switch', { name: 'Share my read position in this room' })
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(picked).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(picked)
    expect(picked).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(picked)
    expect(picked).toHaveAttribute('aria-checked', 'false')
  })

  it('reports a failed room consent save instead of suggesting sharing is enabled', () => {
    const markers = { ...source(false), setRoomEnabled: () => false }
    render(<RoomReadSharing markers={markers} roomJid={room} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Share my read position in this room' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save this choice. Sharing stays off.')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('shows three inline names and opens the exact-position list from an unboxed native link', () => {
    const markers = source()
    markers.setReaders({ first: people })
    const view = render(<RoomReadBadge markers={markers} roomJid={room} row={{ id: 'first', stanzaId: 'archive-first' }} />)
    const opener = screen.getByRole('button', { name: '+1 other: Read through this message: Jules, Maya, Noor, Sam' })
    expect(view.container.querySelector('[data-read-marker-names]')).toHaveTextContent('Jules, Maya, and Noor')
    expect(view.container.querySelector('[data-read-marker-avatar]')).toBeNull()
    expect(opener).toHaveClass('underline', 'min-h-7')
    expect(opener).toHaveTextContent('+1 other')
    opener.focus()
    expect(opener).toHaveFocus()
    // Native buttons supply Enter/Space activation and pointer/touch activation;
    // the actual keyboard and touch journeys are owned by the browser proof.
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Read through this message' })
    expect(view.container).not.toContainElement(dialog)
    expect(document.body).toContainElement(dialog)
    for (const person of people) expect(within(dialog).getByText(person.nick)).toBeVisible()
  })

  it('returns focus to the trigger when pointer activation does not focus the button', async () => {
    const markers = source()
    markers.setReaders({ first: people })
    render(<><input aria-label="Message composer" /><RoomReadBadge markers={markers} roomJid={room} row={{ id: 'first' }} /></>)
    const composer = screen.getByRole('textbox', { name: 'Message composer' })
    const opener = screen.getByRole('button', { name: '+1 other: Read through this message: Jules, Maya, Noor, Sam' })
    composer.focus()
    expect(composer).toHaveFocus()
    // WebKit does not automatically focus a pointer-activated button. The event
    // must establish the return target before the real modal captures focus.
    fireEvent.click(opener)
    expect(screen.getByRole('dialog', { name: 'Read through this message' })).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('keeps an open list until explicit close and never reopens it when badges return', async () => {
    const markers = source()
    markers.setReaders({ first: people })
    render(<><input aria-label="Message composer" /><RoomReadBadge markers={markers} roomJid={room} row={{ id: 'first' }} /></>)
    fireEvent.click(screen.getByRole('button', { name: '+1 other: Read through this message: Jules, Maya, Noor, Sam' }))
    const dialog = screen.getByRole('dialog', { name: 'Read through this message' })
    act(() => markers.setReaders({ first: empty }))
    expect(screen.getByRole('dialog', { name: 'Read through this message' })).toBe(dialog)
    for (const person of people) expect(within(dialog).getByText(person.nick)).toBeVisible()
    act(() => markers.setReaders({ first: [people[0]] }))
    expect(screen.getByRole('dialog', { name: 'Read through this message' })).toBe(dialog)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Read through this message' })).not.toBeInTheDocument())
    const composer = screen.getByRole('textbox', { name: 'Message composer' })
    composer.focus()
    act(() => markers.setReaders({ first: empty }))
    act(() => markers.setReaders({ first: [people[1]] }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(composer).toHaveFocus()
  })

  it('updates only old and new badge subtrees when a reader moves, not the timeline or unrelated badge', () => {
    const markers = source()
    const counts: Record<string, number> = {}
    const commit = (id: string) => { counts[id] = (counts[id] ?? 0) + 1 }
    const timeline = vi.fn(() => <>{['first', 'second', 'unchanged'].map(id =>
      <Profiler key={id} id={id} onRender={commit}><RoomReadBadge markers={markers} roomJid={room} row={{ id, stanzaId: `archive-${id}` }} /></Profiler>)}</>)
    const Timeline = timeline
    markers.setReaders({ first: [people[0]] })
    render(<Timeline />)
    const before = { ...counts }
    act(() => markers.setReaders({ first: empty, second: [people[0]] }))
    expect(timeline).toHaveBeenCalledTimes(1)
    expect(counts.first).toBe(before.first + 1)
    expect(counts.second).toBe(before.second + 1)
    expect(counts.unchanged).toBe(before.unchanged)
  })

  it('notifies the timeline after row commits and ignores unrelated positions', async () => {
    const markers = source()
    const observed: string[] = []
    const reconcile = () => {
      observed.push(document.querySelector('[data-read-marker-names]')?.textContent ?? '')
    }
    const view = render(<RowLayoutContext.Provider value={reconcile}>
      <RoomReadBadge markers={markers} roomJid={room} row={{ id: 'first' }} />
    </RowLayoutContext.Provider>)
    expect(observed).toEqual([])
    act(() => markers.setReaders({ first: people.slice(0, 2) }))
    expect(observed).toEqual(['Jules and Maya'])
    act(() => markers.setReaders({ second: [people[2]] }))
    expect(observed).toEqual(['Jules and Maya'])
    act(() => markers.setReaders({ first: empty }))
    expect(observed).toEqual(['Jules and Maya', ''])
    expect(view.container).toBeEmptyDOMElement()
    act(() => markers.setReaders({ first: [people[0]] }))
    expect(observed).toEqual(['Jules and Maya', '', 'Jules'])
    view.unmount()
    await Promise.resolve()
    expect(observed).toEqual(['Jules and Maya', '', 'Jules', ''])
  })

  it('renders short groups as text without controls and leaves no corner reservation', () => {
    const markers = source()
    markers.setReaders({ first: people.slice(0, 2) })
    const view = render(<RoomReadBadge markers={markers} roomJid={room} row={{ id: 'first', stanzaId: 'archive-first' }} />)
    expect(view.container.querySelector('[data-read-marker-row] .italic')).toHaveTextContent('Read through here:')
    expect(view.container.querySelector('[data-read-marker-names]')).toHaveTextContent('Jules and Maya')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    act(() => markers.setReaders({ first: [people[1], people[0]] }))
    expect(view.container.querySelector('[data-read-marker-names]')).toHaveTextContent('Jules and Maya')
    expect(view.container.querySelector('[data-read-marker-corner]')).toBeNull()
    act(() => markers.setReaders({ first: empty }))
    expect(view.container).toBeEmptyDOMElement()
  })

  it('closes an open list when the parent unmounts the marker and does not reopen on remount', () => {
    const markers = source()
    markers.setReaders({ first: people })
    const badge = <RoomReadBadge markers={markers} roomJid={room} row={{ id: 'first' }} />
    const view = render(badge)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('dialog')).toBeVisible()
    view.rerender(<></>)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(view.container).toBeEmptyDOMElement()
    view.rerender(badge)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveTextContent('+1 other')
  })
})
