/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  useAllRoomSidebarItems,
  useArchivedSidebarItems,
  useChatSidebarItems,
  useRoomOccupants,
  useRoomSidebarItems,
} from './useMetadataSubscriptions'
import { chatStore, roomStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  createConversation,
  createMessage,
  createRoom,
  createRoomMessage,
} from './renderStability.helpers'

const JID = 'roomA@conference.example.com'

describe('useRoomOccupants render stability', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(), messages: new Map(), windowAtLiveEdge: new Map(),
      activeRoomJid: null,
      mamQueryStates: new Map(),
      activeAnimation: null,
      drafts: new Map(),
    })
  })

  it('does NOT re-render when the active room receives messages', () => {
    act(() => {
      roomStore.getState().addRoom(createRoom(JID, { joined: true }))
      roomStore.getState().setActiveRoom(JID)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const occupants = useRoomOccupants(JID)
        return { renderCount, occupants }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount
    const mapAfterMount = result.current.occupants

    act(() => {
      for (let i = 0; i < 10; i++) {
        roomStore.getState().addMessage(JID, createRoomMessage(JID, 'user1', `m${i}`, { id: `m-${i}` }))
      }
    })

    expect(result.current.renderCount).toBe(rendersAfterMount)
    expect(result.current.occupants).toBe(mapAfterMount) // same reference
  })

  it('DOES re-render when an occupant joins or leaves the active room', () => {
    act(() => {
      roomStore.getState().addRoom(createRoom(JID, { joined: true }))
      roomStore.getState().setActiveRoom(JID)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const occupants = useRoomOccupants(JID)
        return { renderCount, occupants }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    act(() => {
      roomStore.getState().addOccupant(JID, { nick: 'alice', affiliation: 'member', role: 'participant' })
    })
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterMount)
    expect(result.current.occupants.has('alice')).toBe(true)

    const rendersAfterJoin = result.current.renderCount
    act(() => {
      roomStore.getState().removeOccupant(JID, 'alice')
    })
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterJoin)
    expect(result.current.occupants.has('alice')).toBe(false)
  })
})

const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'
const CAROL = 'carol@example.com'
const DANA = 'dana@example.com'
const DESIGN = 'design@conference.example.com'
const LOBBY = 'lobby@conference.example.com'
const SUPPORT = 'support@conference.example.com'

function seedSidebars() {
  for (const id of [ALICE, BOB, CAROL, DANA]) {
    chatStore.getState().addConversation(createConversation(id))
  }
  chatStore.getState().archiveConversation(CAROL)
  chatStore.getState().archiveConversation(DANA)
  roomStore.getState().addRoom(createRoom(DESIGN, { name: 'Design', joined: true, isBookmarked: true }))
  roomStore.getState().addRoom(createRoom(LOBBY, { name: 'Lobby', joined: true }))
  roomStore.getState().addRoom(createRoom(SUPPORT, { name: 'Support', joined: true, isBookmarked: true }))
}

type SidebarRow = { name: string; id?: string; jid?: string }

const sidebarHooks: Array<{
  hook: string
  useItems: () => SidebarRow[]
  keys: string[]
  /** Changes one row, identified by `changed`, leaving `kept` alone. */
  changeOneRow: () => void
  changed: string
  kept: string
}> = [
  {
    hook: 'useChatSidebarItems',
    useItems: useChatSidebarItems,
    keys: [ALICE, BOB],
    changeOneRow: () => chatStore.getState().setDraft(ALICE, 'draft'),
    changed: ALICE,
    kept: BOB,
  },
  {
    hook: 'useArchivedSidebarItems',
    useItems: useArchivedSidebarItems,
    keys: [CAROL, DANA],
    changeOneRow: () => chatStore.getState().setDraft(CAROL, 'draft'),
    changed: CAROL,
    kept: DANA,
  },
  {
    hook: 'useAllRoomSidebarItems',
    useItems: useAllRoomSidebarItems,
    keys: [DESIGN, LOBBY, SUPPORT],
    changeOneRow: () => roomStore.getState().setDraft(LOBBY, 'draft'),
    changed: LOBBY,
    kept: DESIGN,
  },
  {
    hook: 'useRoomSidebarItems',
    useItems: useRoomSidebarItems,
    keys: [DESIGN, SUPPORT],
    changeOneRow: () => roomStore.getState().setDraft(SUPPORT, 'draft'),
    changed: SUPPORT,
    kept: DESIGN,
  },
]

const rowKey = (row: SidebarRow) => row.id ?? row.jid

describe.each(sidebarHooks)('$hook render stability', ({ useItems, keys, changeOneRow, changed, kept }) => {
  const mount = () => renderHook(
    () => ({ renderCount: useRenderCount(), items: useItems() }),
    { wrapper },
  )
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    chatStore.getState().reset()
    roomStore.getState().reset()
    consoleError = vi.spyOn(console, 'error')
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('mounts on empty stores, then shows items added later, without an update loop', () => {
    const { result } = mount()
    expect(result.current.items).toEqual([])

    act(() => seedSidebars())

    expect(result.current.items.map(rowKey)).toEqual(keys)
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('getSnapshot'))
  })

  it('keeps the same list and does not re-render on unrelated store changes', () => {
    act(() => seedSidebars())
    const { result } = mount()
    const rendersAfterMount = result.current.renderCount
    const itemsAfterMount = result.current.items

    act(() => {
      chatStore.getState().setActiveConversation(BOB)
      chatStore.getState().setTyping(BOB, BOB, true)
      roomStore.getState().setActiveRoom(DESIGN)
      roomStore.getState().setTyping(DESIGN, 'erin', true)
    })

    expect(result.current.renderCount).toBe(rendersAfterMount)
    expect(result.current.items).toBe(itemsAfterMount)
  })

  it('replaces only the row whose content changed', () => {
    act(() => seedSidebars())
    const { result } = mount()
    const before = result.current.items

    act(() => changeOneRow())

    const after = result.current.items
    const find = (rows: SidebarRow[], key: string) => rows.find((row) => rowKey(row) === key)
    expect(after).not.toBe(before)
    expect(find(after, changed)).not.toBe(find(before, changed))
    expect(find(after, kept)).toBe(find(before, kept))
  })
})

describe('useChatSidebarItems ordering', () => {
  beforeEach(() => {
    chatStore.getState().reset()
    roomStore.getState().reset()
  })

  it('moves a conversation to the top on a new message and keeps the other row object', () => {
    act(() => seedSidebars())
    const { result } = renderHook(() => useChatSidebarItems(), { wrapper })
    const aliceBefore = result.current.find((row) => row.id === ALICE)

    act(() => {
      chatStore.getState().addMessage(createMessage(BOB, 'Hello', { id: 'm-1' }))
    })

    expect(result.current.map((row) => row.id)).toEqual([BOB, ALICE])
    expect(result.current[0].lastMessage?.body).toBe('Hello')
    expect(result.current.find((row) => row.id === ALICE)).toBe(aliceBefore)
  })
})
