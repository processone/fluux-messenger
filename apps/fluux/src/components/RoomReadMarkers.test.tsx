import { Profiler } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MessageRowRef, RoomReadConsent, RoomReader } from '@fluux/sdk'
import { RoomReadBadge, RoomReadCorner, RoomReadSharing } from './RoomReadMarkers'

// Approved room read-marker UI: consent controls and badge snapshots only.
// SDK protocol/order/persistence facts belong to RoomReadMarkers.test.ts.
const room = 'reading@conference.localhost'
const empty: readonly RoomReader[] = []
function source() {
  const listeners = new Set<() => void>()
  let consent: RoomReadConsent = { enabled: false, rooms: [] }
  const badges = new Map<string, readonly RoomReader[]>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getConsent: () => consent,
    setEnabled: (enabled: boolean) => { consent = { ...consent, enabled }; notify(); return true },
    setRoomEnabled: (jid: string, enabled: boolean) => {
      consent = { ...consent, rooms: [...consent.rooms.filter(value => value !== jid), ...(enabled ? [jid] : [])] }; notify(); return true
    },
    showsBadges: () => true,
    readers: (_room: string, row: MessageRowRef) => badges.get(row.id) ?? empty,
    setReaders: (rows: Record<string, readonly RoomReader[]>) => { for (const [row, readers] of Object.entries(rows)) badges.set(row, readers); notify() },
  }
}

const people: readonly RoomReader[] = [
  { occupantId: 'sam-id', nick: 'Sam' }, { occupantId: 'jules-id', nick: 'Jules' },
  { occupantId: 'noor-id', nick: 'Noor' }, { occupantId: 'maya-id', nick: 'Maya' },
]

// Names remain visible and translated by the same path as the product.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { names?: string }) => {
  const labels: Record<string, string> = {
    'readMarkers.master': 'Share room read positions', 'readMarkers.shareInRoom': 'Share my read position in this room',
    'readMarkers.readThrough': 'Read through this message', 'readMarkers.masterOff': 'The Privacy master switch is off.',
    'readMarkers.saveFailed': 'Could not save this choice. Sharing stays off.',
    'readMarkers.readers': `Read through this message: ${values?.names ?? ''}`,
  }
  return labels[key] ?? key
} }) }))

describe('room read-marker controls', () => {
  it('shows two off-by-default switches and leaves the master off when choosing a room', () => {
    const markers = source()
    render(<><RoomReadSharing markers={markers} /><RoomReadSharing markers={markers} roomJid={room} /></>)
    const master = screen.getByRole('switch', { name: 'Share room read positions' })
    const picked = screen.getByRole('switch', { name: 'Share my read position in this room' })
    expect(master).toHaveAttribute('aria-checked', 'false')
    expect(picked).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(picked)
    expect(picked).toHaveAttribute('aria-checked', 'true')
    expect(master).toHaveAttribute('aria-checked', 'false')
    expect(markers.getConsent().rooms).toEqual([room])
    fireEvent.click(master)
    expect(master).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(master)
    expect(master).toHaveAttribute('aria-checked', 'false')
  })

  it('reports a failed consent save instead of suggesting sharing is enabled', () => {
    const markers = { ...source(), setEnabled: () => false }
    render(<RoomReadSharing markers={markers} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Share room read positions' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save this choice. Sharing stays off.')
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('caps avatars at three and opens a fully named list with an accessible native button', () => {
    const markers = source()
    markers.setReaders({ first: people })
    const view = render(<RoomReadBadge markers={markers} roomJid={room} row={{ id: 'first', stanzaId: 'archive-first' }} />)
    const opener = screen.getByRole('button', { name: 'Read through this message: Sam, Jules, Noor, Maya' })
    expect(opener.querySelectorAll('[data-read-marker-avatar]')).toHaveLength(3)
    expect(within(opener).getByText('+1')).toBeVisible()
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
    const opener = screen.getByRole('button', { name: 'Read through this message: Sam, Jules, Noor, Maya' })
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
    fireEvent.click(screen.getByRole('button', { name: 'Read through this message: Sam, Jules, Noor, Maya' }))
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

  it('reserves a decorative corner only in qualifying rooms and keeps it unchanged when readers move', () => {
    let eligible = false
    const state = source()
    const markers = { ...state, showsBadges: () => eligible }
    const view = render(<RoomReadCorner markers={markers} roomJid={room} />)
    expect(view.container.childElementCount).toBe(0)
    eligible = true
    act(() => markers.setReaders({ first: [people[0]] }))
    const corner = view.container.querySelector('[data-read-marker-corner]')!
    expect(corner).toHaveAttribute('aria-hidden', 'true')
    act(() => markers.setReaders({ first: empty, second: [people[0]] }))
    expect(view.container.querySelector('[data-read-marker-corner]')).toBe(corner)
    expect(view.container.textContent).toBe('')
  })

})
