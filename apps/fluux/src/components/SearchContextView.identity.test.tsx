/** @vitest-environment jsdom */
import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { clearAllMessages, saveRoomMessages } from '@fluux/sdk/cache'
import { roomStore } from '@fluux/sdk/stores'
import { useSearch, messageRowRef, type SearchResult } from '@fluux/sdk'
import { confirmedRoomMessage } from '@/test-utils/roomMessages'
import { findMessageRowElement, messageTargetRowId } from './conversation/messageRowIdentity'
import { SearchContextView } from './SearchContextView'

const navigation = vi.hoisted(() => ({ navigateToRoom: vi.fn(), navigateToConversation: vi.fn() }))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => navigation }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))

beforeEach(async () => {
  await clearAllMessages()
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
  navigation.navigateToRoom.mockClear()
})

it('loads and highlights only confirmed B and navigates to its exact rendered row', async () => {
  const legacy = { type: 'groupchat' as const, roomJid: 'search@conference.example.com', from: 'search@conference.example.com/Peer',
    nick: 'Peer', id: 'shared', occupantId: 'peer', stanzaId: 'same', body: 'Earlier uncertain A', timestamp: new Date(1000), isOutgoing: false }
  const confirmed = confirmedRoomMessage({ ...legacy, body: 'Later confirmed B', timestamp: new Date(2000) })
  await saveRoomMessages([legacy, confirmed])
  const previewResult: SearchResult = { indexId: 'confirmed', messageId: confirmed.id, isRoom: true, conversationId: confirmed.roomJid,
    conversationName: 'Search room', from: confirmed.from, stanzaId: confirmed.stanzaId, occupantId: confirmed.occupantId,
    stanzaIdAuthority: confirmed.stanzaIdAuthority, body: confirmed.body, timestamp: +confirmed.timestamp, source: 'local', matchSnippet: null }
  const setPreviewResult = vi.fn()
  const searchState = vi.mocked(useSearch).getMockImplementation()!()
  vi.mocked(useSearch).mockReturnValue({ ...searchState, previewResult, query: 'unmatched', setPreviewResult })
  const { container } = render(<SearchContextView />)
  await screen.findByText(confirmed.body)
  const first = screen.getByText(legacy.body).closest<HTMLElement>('[data-message-row-id]')!
  const second = screen.getByText(confirmed.body).closest<HTMLElement>('[data-message-row-id]')!
  expect(first).not.toBe(second)
  await waitFor(() => expect(second).toHaveClass('message-highlight-persistent'))
  expect(first).not.toHaveClass('message-highlight-persistent')
  fireEvent.click(screen.getByText(legacy.body))
  expect(navigation.navigateToRoom).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText(confirmed.body))
  expect(navigation.navigateToRoom).toHaveBeenCalledOnce()
  let handle = navigation.navigateToRoom.mock.calls[0][1]
  expect(handle).toEqual(messageRowRef(confirmed))
  expect(findMessageRowElement(container, messageTargetRowId(handle))).toBe(second)
  navigation.navigateToRoom.mockClear()
  fireEvent.click(screen.getByText('search.goToMessage'))
  handle = navigation.navigateToRoom.mock.calls[0][1]
  expect(findMessageRowElement(container, messageTargetRowId(handle))).toBe(second)
})
