import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { useMessageRequestPreviewStore } from '@/stores/messageRequestPreviewStore'
import { APP_NAME, formatWindowTitle, useNativeWindowTitle, useOpenConversationName } from './useWindowTitle'

const setTitle = vi.fn(async (_title: string) => {})
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle }),
}))

const CHAT = 'alice@example.com'
const ROOM = 'team@conference.example.com'

// The two slices the hook selects from, stated per case.
let chatState: { conversations: Map<string, { name: string }>; activeConversationId: string | null }
let roomState: { rooms: Map<string, { name: string }>; activeRoomJid: string | null }
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
  useRoomStore: (selector: (state: typeof roomState) => unknown) => selector(roomState),
}))

function openChat(name = 'Alice') {
  chatState = { conversations: new Map([[CHAT, { name }]]), activeConversationId: CHAT }
}

function openRoom(name = 'Team Chat') {
  roomState = { rooms: new Map([[ROOM, { name }]]), activeRoomJid: ROOM }
}

function at(path: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  )
}

describe('formatWindowTitle', () => {
  it('is the bare app name when no conversation is open', () => {
    expect(formatWindowTitle(null)).toBe('Fluux Messenger')
  })

  it('appends the open conversation after the app name', () => {
    expect(formatWindowTitle('Team Chat')).toBe('Fluux Messenger — Team Chat')
  })
})

describe('useOpenConversationName', () => {
  beforeEach(() => {
    chatState = { conversations: new Map(), activeConversationId: null }
    roomState = { rooms: new Map(), activeRoomJid: null }
    useMessageRequestPreviewStore.setState({ previewJid: null })
  })

  it('is null when nothing is open', () => {
    const { result } = renderHook(() => useOpenConversationName(), { wrapper: at('/messages') })
    expect(result.current).toBeNull()
  })

  it('names the open one-to-one conversation', () => {
    openChat('Alice')
    const { result } = renderHook(() => useOpenConversationName(), { wrapper: at('/messages') })
    expect(result.current).toBe('Alice')
  })

  it('names the open room', () => {
    openRoom('Team Chat')
    const { result } = renderHook(() => useOpenConversationName(), { wrapper: at('/rooms') })
    expect(result.current).toBe('Team Chat')
  })

  it('prefers the room, which the main pane renders first', () => {
    openChat('Alice')
    openRoom('Team Chat')
    const { result } = renderHook(() => useOpenConversationName(), { wrapper: at('/rooms') })
    expect(result.current).toBe('Team Chat')
  })

  it('does not fall back to the chat behind a room whose name is not known yet', () => {
    openChat('Alice')
    roomState = { rooms: new Map(), activeRoomJid: ROOM }
    const { result } = renderHook(() => useOpenConversationName(), { wrapper: at('/rooms') })
    expect(result.current).toBeNull()
  })

  it('is null in settings, which replace the conversation that stays active underneath', () => {
    openChat('Alice')
    const { result } = renderHook(() => useOpenConversationName(), { wrapper: at('/settings/appearance') })
    expect(result.current).toBeNull()
  })

  it('is null while a message request is previewed over the conversation', () => {
    openChat('Alice')
    useMessageRequestPreviewStore.setState({ previewJid: 'stranger@example.com' })
    const { result } = renderHook(() => useOpenConversationName(), { wrapper: at('/messages') })
    expect(result.current).toBeNull()
  })
})

describe('useNativeWindowTitle', () => {
  beforeEach(() => setTitle.mockClear())
  afterEach(() => vi.clearAllMocks())

  it('sets the OS window title and follows it', async () => {
    const { rerender } = renderHook(({ title }) => useNativeWindowTitle(title), {
      initialProps: { title: 'Fluux Messenger — Alice' },
    })
    await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith('Fluux Messenger — Alice'))

    rerender({ title: 'Fluux Messenger — Team Chat' })
    await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith('Fluux Messenger — Team Chat'))
  })

  it('hands the title back to the bare app name on unmount', async () => {
    const { unmount } = renderHook(() => useNativeWindowTitle('Fluux Messenger — Alice'))
    await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith('Fluux Messenger — Alice'))

    unmount()
    await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith(APP_NAME))
  })
})
