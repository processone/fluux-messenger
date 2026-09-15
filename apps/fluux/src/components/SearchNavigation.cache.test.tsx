/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { clearAllMessages, saveRoomMessages } from '@fluux/sdk/cache'
import { roomStore } from '@fluux/sdk/stores'
import { useRoomStore } from '@fluux/sdk/react'
import { messageRowRef, useSearch, type RoomMessage, type SearchResult } from '@fluux/sdk'
import { roomMessageFixture } from '@/test-utils/roomMessages'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { scrollStateManager } from '@/utils/scrollStateManager'
import { SearchContextView } from './SearchContextView'
import { MessageList } from './conversation/MessageList'
import { messageRowId } from './conversation/messageRowIdentity'

vi.unmock('@fluux/sdk/react')
vi.mock('./conversation/UserInfoPopover', () => ({ UserInfoPopover: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/utils/dismissNotification', () => ({ dismissNotification: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))

const originalScrollIntoView = Element.prototype.scrollIntoView
const ROOM = 'navigation@conference.example.com'
const EMPTY: RoomMessage[] = []
const loadAround = vi.fn((ref: Parameters<ReturnType<typeof roomStore.getState>['loadMessagesAroundFromCache']>[1]) =>
  roomStore.getState().loadMessagesAroundFromCache(ROOM, ref, { before: 1, after: 1 }))
function LiveList({ literal }: { literal?: string }) {
  const messages = useRoomStore(state => state.messages.get(ROOM) ?? EMPTY)
  const targetMessageId = useRoomStore(state => state.targetMessageId)
  const { navigateToRoom } = useNavigateToTarget()
  return <div data-testid="live-list">
    <button type="button" onClick={() => navigateToRoom(ROOM, literal)}>Open literal</button>
    <MessageList messages={messages} conversationId={ROOM} targetMessageId={targetMessageId}
      onTargetMessageConsumed={() => roomStore.getState().setTargetMessageId(null)}
      onLoadAround={loadAround} renderMessage={message => <span>{message.body}</span>} />
  </div>
}
function row(id: string, time: number, body: string): RoomMessage {
  return roomMessageFixture({ type: 'groupchat', roomJid: ROOM, from: ROOM + '/Peer', nick: 'Peer',
    id, occupantId: 'peer', stanzaId: 'archive-' + id, body, timestamp: new Date(time), isOutgoing: false })
}
beforeEach(async () => {
  Element.prototype.scrollIntoView = vi.fn()
  await clearAllMessages()
  roomStore.getState().reset()
  roomStore.getState().addRoom({ jid: ROOM, name: 'Navigation', nickname: 'Me', joined: true, isBookmarked: true,
    occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() })
  roomStore.getState().setActiveRoom(ROOM)
  scrollStateManager.reset()
  localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')
  loadAround.mockClear()
})
afterEach(() => { cleanup(); Element.prototype.scrollIntoView = originalScrollIntoView; localStorage.clear(); roomStore.getState().reset() })

it('loads an evicted search result through navigation and highlights its confirmed occurrence', async () => {
  const target = row('shared', 2000, 'Confirmed target')
  const uncertain = { ...target,  timestamp: new Date(1000), body: 'Uncertain collision' }
  const latest = Array.from({ length: 120 }, (_, i) => row('tail-' + i, 3000 + i, 'Recent ' + i))
  await saveRoomMessages([uncertain, target, ...latest])
  roomStore.setState({ messages: new Map([[ROOM, latest]]) })
  const previewResult: SearchResult = { indexId: 'target', messageId: target.id, isRoom: true, conversationId: ROOM,
    conversationName: 'Navigation', from: target.from, stanzaId: target.stanzaId, occupantId: target.occupantId,
     body: target.body, timestamp: +target.timestamp, source: 'local', matchSnippet: null }
  vi.mocked(useSearch).mockReturnValue({ ...vi.mocked(useSearch).getMockImplementation()!(), previewResult, query: 'unmatched', setPreviewResult: vi.fn() })
  render(<MemoryRouter><SearchContextView /><LiveList /></MemoryRouter>)
  await screen.findByText(target.body)
  const live = screen.getByTestId('live-list')
  expect(live.textContent).not.toContain(target.body)
  fireEvent.click(screen.getByText('search.goToMessage'))
  await waitFor(() => expect(live.textContent).toContain(target.body))
  expect(loadAround).toHaveBeenCalledWith(messageRowRef(target))
  await waitFor(() => {
    const highlighted = live.querySelector<HTMLElement>('.message-highlight')
    expect(highlighted?.dataset.messageRowId).toBe(messageRowId(target))
  })
})

it.each(['occupant-row:["wire","peer"]', 'archive-row:["wire","peer","archive"]', 'client-row:"wire"'])(
  'navigates a literal opaque ID in the DOM and cache: %s', async literal => {
    const target = row(literal, 1000, 'Literal target')
    const decoy = row('wire', 2000, 'Decoded decoy')
    const latest = Array.from({ length: 120 }, (_, i) => row('tail-' + i, 3000 + i, 'Recent ' + i))
    await saveRoomMessages([target, decoy, ...latest])
    roomStore.setState({ messages: new Map([[ROOM, [decoy, ...latest]]]) })
    render(<MemoryRouter><LiveList literal={literal} /></MemoryRouter>)
    fireEvent.click(screen.getByText('Open literal'))
    const live = screen.getByTestId('live-list')
    await waitFor(() => expect(live.textContent).toContain(target.body))
    expect(loadAround).toHaveBeenCalledWith({ id: literal })
    await waitFor(() => expect(live.querySelector<HTMLElement>('.message-highlight')?.dataset.messageId).toBe(literal))
  },
)
