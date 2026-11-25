/**
 * @vitest-environment jsdom
 *
 * Behaviour that ChatView and RoomView share: the conversation thread. One case list runs
 * against both real views (describe.each), so a behaviour the two views must keep identical
 * cannot drift in one of them. Source of intent: FLM-571 (move the shared thread code into
 * one component without changing behaviour) under FLM-559's guardrail-first rule.
 *
 * What is faked: the SDK's active-conversation hooks, and three boundaries the thread talks
 * to through props — the message list, the composer and the header. They are stubs that record
 * their props and expose the callbacks the thread hands them. Everything the thread owns runs
 * for real: message selection, find on page, drag and drop, attachment staging, type to focus.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import type { Message, RoomMessage, Room } from '@fluux/sdk'
import type { FindOnPageHandle } from '@/hooks/useFindOnPage'
import type { MessageListProps } from './conversation/MessageList'
import type { MessageComposerHandle } from './MessageComposer'
import { messageRowId } from './conversation/messageRowIdentity'
import { reactionMentionStore } from '@/stores/reactionMentionStore'
import { easterEggMentionStore } from '@/stores/easterEggMentionStore'
import { ChatView } from './ChatView'
import { RoomView } from './RoomView'
import { ModalOverlay } from './ModalOverlay'
import { MODAL_EXIT_MS } from '@/hooks/useModalTransition'

const h = vi.hoisted(() => ({
  chat: null as Record<string, unknown> | null,
  room: null as Record<string, unknown> | null,
  roomObject: null as unknown,
  listProps: null as unknown,
  composerProps: null as null | Record<string, unknown>,
  headerProps: null as null | Record<string, unknown>,
  focus: undefined as undefined | (() => void),
  reportViewport: undefined as undefined | ((...args: unknown[]) => void),
  triggerAnimation: undefined as unknown as (...args: unknown[]) => void,
  setTargetMessageId: undefined as unknown as (...args: unknown[]) => void,
  findFirstMessageOfDay: vi.fn(),
  archiveMessages: {},
  serverInfo: null as { features: string[] } | null,
  emptySet: new Set<string>(),
  emptyMap: new Map<string, number>(),
  blocked: new Set<string>(),
  ignored: {} as Record<string, never>,
}))

vi.mock('@/utils/featureFlags', () => ({ isFeatureEnabled: () => false }))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useChatActive: () => h.chat,
    useRoomActive: () => h.room,
    useContactIdentities: () => new Map(),
    useReferencedMessage: () => undefined,
    useRoomMessageSnapshots: (_jid: string, messages: unknown) => messages,
    useXMPPContext: () => ({ client: { e2ee: null, messages: h.archiveMessages } }),
    findFirstMessageOfDay: h.findFirstMessageOfDay,
    useXMPP: () => ({ client: { profile: { fetchProfileDetails: vi.fn().mockResolvedValue(null) } }, sendRawXml: vi.fn(), onStanza: vi.fn(() => vi.fn()), on: vi.fn(() => vi.fn()), setPresence: vi.fn(), xml: vi.fn(), isConnected: () => false, getJid: () => null }),
    useRosterActions: () => ({ addContact: vi.fn(), removeContact: vi.fn(), renameContact: vi.fn() }),
    useBlocking: () => ({ blockJid: vi.fn(), unblockJid: vi.fn() }),
    usePolls: () => ({ sendPoll: vi.fn(), votePoll: vi.fn(), closePoll: vi.fn() }),
    useRoomModeration: () => ({ moderateMessage: vi.fn(), setAffiliation: vi.fn(), setRole: vi.fn() }),
    useRoomManagement: () => ({ setRoomNotifyLevel: vi.fn(), setRoomAvatar: vi.fn(), clearRoomAvatar: vi.fn(), submitRoomConfig: vi.fn(), setSubject: vi.fn(), destroyRoom: vi.fn() }),
    useRoomActions: () => ({ joinRoom: vi.fn(), joinResult: vi.fn(), getRoomInfo: vi.fn(), acknowledgeNonAnonymousRoom: vi.fn(), isNonAnonymousRoomAcknowledged: () => false }),
    useRoomEntity: () => (h.roomObject ? { name: 'Room', nickname: 'Me' } : undefined),
    chatStore: {
      getState: () => ({ triggerAnimation: h.triggerAnimation, setTargetMessageId: h.setTargetMessageId }),
      subscribe: () => () => {},
    },
    getStorageScopeJid: () => 'me@example.com',
    currentViewportGeneration: () => 7,
    reportViewport: (...args: unknown[]) => h.reportViewport?.(...args),
  }
})

vi.mock('@fluux/sdk/stores', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk/stores')>()),
  roomStore: {
    getState: () => ({
      triggerAnimation: h.triggerAnimation, setTargetMessageId: h.setTargetMessageId,
      activeRoom: () => h.roomObject, activeMessages: () => (h.room as { activeMessages: unknown[] }).activeMessages,
      messages: new Map(), getRoom: () => h.roomObject, getDraft: () => '', setDraft: () => {}, clearDraft: () => {}, clearFirstNewMessageId: () => {}, dismissPoll: () => {},
    }),
    subscribe: () => () => {},
  },
}))

vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ interiorPlacementVersions: h.emptyMap }),
  useRoomStore: (selector: (s: unknown) => unknown) => selector({
    interiorPlacementVersions: h.emptyMap, getVotedPollIds: () => h.emptySet, getDismissedPollIds: () => h.emptySet,
  }),
  useConnectionStore: (selector: (s: unknown) => unknown) => selector({
    jid: 'me@example.com/resource', ownAvatar: null, ownNickname: 'Me', status: 'online', serverInfo: h.serverInfo, httpUploadService: { supportsRetention: false },
  }),
  useBlockingStore: (selector: (s: unknown) => unknown) => selector({ blockedJids: h.blocked }),
  useIgnoreStore: (selector: (s: unknown) => unknown) => selector({ ignoredUsers: h.ignored }),
  useSavedStore: (selector: (s: unknown) => unknown) => selector({ entries: {} }),
  useEventsStore: (selector: (s: unknown) => unknown) => selector({ voiceRequests: [], voiceRequestStatuses: {} }),
  useRosterStore: (selector: (s: unknown) => unknown) => selector({ contacts: new Map() }),
  useContactTime: () => null,
  useLastActivity: () => {},
}))

vi.mock('@/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks')>()),
  useFileUpload: () => ({ uploadFile: vi.fn(), isUploading: false, progress: 0, isSupported: true, error: null, clearError: vi.fn(), maxFileSize: undefined }),
  useLinkPreview: () => ({ processMessageForLinkPreview: vi.fn().mockResolvedValue(undefined) }),
  useMode: () => ({ resolvedMode: 'dark', isDark: true }),
  useConversationDraft: () => React.useState(''),
  useWhisperCounterpartPresent: () => true,
  useRoomOccupantCountBelow: () => true,
  useMentionAutocomplete: () => ({
    state: { isActive: false, query: '', triggerIndex: -1, selectedIndex: 0, matches: [] },
    selectMatch: vi.fn(), moveSelection: vi.fn(), dismiss: vi.fn(),
  }),
}))
vi.mock('@/hooks/useRoomJoinWarning', () => ({ useRoomJoinWarning: () => ({ confirmJoin: () => Promise.resolve(true), warningDialog: null }) }))
vi.mock('@/hooks/useConversationEncryptionState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useConversationEncryptionState')>()),
  useConversationEncryptionState: () => ({ kind: 'disabled' }),
}))
vi.mock('@/hooks/useHasHover', () => ({ useHasHover: () => true, hasHover: () => true }))
vi.mock('./easter-eggs/EasterEggAnimation', () => ({ EasterEggAnimation: () => <div data-testid="easter-egg-animation" /> }))
vi.mock('./OccupantPanel', () => ({ OccupantPanel: () => <div data-testid="occupant-panel" /> }))

// The list boundary: records its props and draws every row through the view's own renderMessage.
vi.mock('./conversation/MessageList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversation/MessageList')>()
  const { DateSeparator } = await import('./conversation/DateSeparator')
  const { localDayValue } = await import('@fluux/sdk')
  return {
    ...actual,
    MessageList: (props: MessageListProps<Message>) => {
      h.listProps = props
      const rows = props.timeline.messages
      return (
        <div data-testid="list">
          {rows[0] && <DateSeparator date={localDayValue(rows[0].timestamp)} onSelect={props.timeline.window?.onJumpToDate} />}
          {rows.map((m, i) => (
            <div key={messageRowId(m)} data-message-row-id={messageRowId(m)} data-message-id={messageRowId(m)}>
              {props.renderMessage(m, i, rows, false, () => {})}
            </div>
          ))}
        </div>
      )
    },
  }
})

// The composer boundary: records its props and exposes a focus handle.
vi.mock('./MessageComposer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./MessageComposer')>()
  return {
    ...actual,
    MessageComposer: function StubComposer(props: Record<string, unknown> & { ref?: React.Ref<MessageComposerHandle> }) {
      h.composerProps = props
      React.useImperativeHandle(props.ref, () => ({
        focus: () => h.focus?.(),
        getText: () => '',
        setText: () => {},
        placeCaret: () => {},
      }))
      return <div data-testid="composer" />
    },
  }
})

// The header boundary: the thread hands it the search and saved handlers.
vi.mock('./ChatHeader', () => ({
  ChatHeader: (props: Record<string, unknown>) => { h.headerProps = props; return <div data-testid="header"><button type="button" data-header-overflow-trigger>Conversation actions</button></div> },
}))
vi.mock('./RoomHeader', () => ({
  RoomHeader: (props: Record<string, unknown>) => { h.headerProps = props; return <div data-testid="header"><button type="button" data-header-overflow-trigger>Conversation actions</button></div> },
}))

const ME = 'me@example.com'

function chatMessage(id: string, overrides: Partial<Message> = {}): Message {
  return {
    stanzaId: undefined, originId: undefined, type: 'chat', id, conversationId: 'alice@example.com',
    from: 'alice@example.com', body: `body ${id}`, timestamp: new Date('2024-01-15T10:00:00Z'), isOutgoing: false,
    ...overrides,
  } as Message
}

function roomMessage(id: string, overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    stanzaId: undefined, originId: undefined, occupantId: undefined, type: 'groupchat', id,
    roomJid: 'room@conference.example.com', from: 'room@conference.example.com/alice', nick: 'Alice',
    body: `body ${id}`, timestamp: new Date('2024-01-15T10:00:00Z'), isOutgoing: false,
    ...overrides,
  } as RoomMessage
}

function makeRoom(jid: string): Room {
  return {
    jid, name: 'Room', joined: true, nickname: 'Me', occupants: new Map(), typingUsers: new Set(),
    unreadCount: 0, mentionsCount: 0, isBookmarked: false, supportsMAM: true,
  } as unknown as Room
}

interface Kind {
  name: 'chat' | 'room'
  /** Conversation ids used to switch between two conversations of this kind. */
  ids: [string, string]
  /** The key reportViewport receives. */
  viewportKind: 'chat' | 'room'
  messages(ownLast?: boolean): Array<Message | RoomMessage>
  /** Points the SDK fake at conversation `id`, with `messages`. */
  activate(id: string, messages: Array<Message | RoomMessage>): void
  /** Renders the view. */
  mount(props?: Record<string, unknown>): ReturnType<typeof render>
  /** What the sidebar offers: the store call the easter egg and reaction pill make. */
  storeSpies: { triggerAnimation: ReturnType<typeof vi.fn>; setTargetMessageId: ReturnType<typeof vi.fn> }
  /** Spies for what the SDK fake hands the view. */
  sdk: { clearFirstNewMessageId: ReturnType<typeof vi.fn>; advanceReadPointer: ReturnType<typeof vi.fn> }
}

const sdk = { clearFirstNewMessageId: vi.fn(), advanceReadPointer: vi.fn() }
const storeSpies = { triggerAnimation: vi.fn(), setTargetMessageId: vi.fn() }

const baseActive = {
  activeMessageIngressVersion: 0, activeTypingUsers: [] as string[], activeAnimation: null,
  clearAnimation: vi.fn(), sendEasterEgg: vi.fn(), sendReaction: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(), sendCorrection: vi.fn(), retractMessage: vi.fn(), retryMessage: vi.fn(),
  sendChatState: vi.fn(), sendWhisperChatState: vi.fn(), sendWhisper: vi.fn(),
  fetchOlderHistory: vi.fn(), loadMessagesAround: vi.fn(), loadNewer: vi.fn(), recenterToLatest: vi.fn(),
  windowAtLiveEdge: true, continueChatCatchUp: vi.fn(), continueRoomCatchUp: vi.fn(),
  activeHistoryState: undefined, targetMessageId: undefined, clearTargetMessageId: vi.fn(),
  firstNewMessageRow: undefined, firstNewMessageIsProvisional: false, firstNewMessageCount: 0, readPointerRow: undefined,
  isArchived: () => false, archiveConversation: vi.fn(), unarchiveConversation: vi.fn(),
  setDraft: vi.fn(), getDraft: () => '', clearDraft: vi.fn(),
}

const KINDS: Kind[] = [
  {
    name: 'chat',
    ids: ['alice@example.com', 'bob@example.com'],
    viewportKind: 'chat',
    messages: () => [chatMessage('m1'), chatMessage('m2', { isOutgoing: true, from: ME }), chatMessage('m3')],
    activate(id, messages) {
      h.chat = {
        ...baseActive, ...sdk,
        activeConversation: { id, name: id.split('@')[0], type: 'chat', unreadCount: 3 },
        activeMessages: messages,
      }
    },
    mount: (props) => render(<ChatView {...props} />),
    storeSpies, sdk,
  },
  {
    name: 'room',
    ids: ['room@conference.example.com', 'other@conference.example.com'],
    viewportKind: 'room',
    messages: () => [roomMessage('m1'), roomMessage('m2', { isOutgoing: true, nick: 'Me' }), roomMessage('m3')],
    activate(id, messages) {
      const room = makeRoom(id)
      h.roomObject = room
      h.room = { ...baseActive, ...sdk, activeRoom: room, activeMessages: messages }
    },
    mount: (props) => render(<RoomView {...props} />),
    storeSpies, sdk,
  },
]

const root = () => document.body.firstElementChild!.firstElementChild as HTMLElement
const listProps = () => h.listProps as MessageListProps<Message>
const composerProps = () => h.composerProps as Record<string, unknown> & {
  replyingTo?: { id: string } | null
  editingMessage?: { id: string } | null
  pendingAttachment?: { file: File } | null
}
/** A send through the composer: the SDK hands back `id`, and the composer reports it as sent. */
async function send(id: string) {
  ;(baseActive.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(id)
  await act(async () => { await (h.composerProps!.onSend as (t: string) => Promise<boolean>)('hello') })
}
const callProp = (name: string, ...args: unknown[]) => act(() => { (h.composerProps![name] as (...a: unknown[]) => void)(...args) })

function rowOf(id: string): HTMLElement {
  return document.querySelector(`[data-message-row-id="${id}"]`) as HTMLElement
}

/** The row's toolbar button whose icon carries `lucide-<icon>`. */
function toolButton(row: HTMLElement, icon: string): HTMLElement {
  const svg = row.querySelector(`svg.lucide-${icon}`)
  if (!svg) throw new Error(`row ${row.getAttribute('data-message-row-id')} has no ${icon} button`)
  return svg.closest('button') as HTMLElement
}

describe.each(KINDS)('conversation thread: $name view', (kind) => {
  const [firstId, secondId] = kind.ids
  const toolbarOf = (id: string) => rowOf(id).querySelector('[data-message-toolbar]') as HTMLElement
  const droppedFile = () => new File(['x'], 'photo.png', { type: 'image/png' })

  beforeEach(() => {
    vi.clearAllMocks()
    h.listProps = null
    h.composerProps = null
    h.headerProps = null
    h.serverInfo = null
    h.focus = vi.fn()
    h.reportViewport = vi.fn()
    kind.activate(firstId, kind.messages())
    h.triggerAnimation = storeSpies.triggerAnimation
    h.setTargetMessageId = storeSpies.setTargetMessageId
    reactionMentionStore.setState({ mentions: new Map() })
    easterEggMentionStore.setState({ mentions: new Map() })
    Element.prototype.scrollIntoView = vi.fn()
    URL.createObjectURL = vi.fn(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => { vi.useRealTimers() })

  describe('send highlight', () => {
    it('highlights the sent message and drops the highlight after 400 ms', async () => {
      vi.useFakeTimers()
      kind.mount()
      expect(listProps().lastSentMessageId).toBeFalsy()
      await send('m2')
      expect(listProps().lastSentMessageId).toBe('m2')
      act(() => { vi.advanceTimersByTime(399) })
      expect(listProps().lastSentMessageId).toBe('m2')
      act(() => { vi.advanceTimersByTime(1) })
      expect(listProps().lastSentMessageId).toBeFalsy()
    })

    it('restarts the 400 ms window when a second message is sent', async () => {
      vi.useFakeTimers()
      kind.mount()
      await send('m2')
      act(() => { vi.advanceTimersByTime(300) })
      await send('m3')
      act(() => { vi.advanceTimersByTime(300) })
      expect(listProps().lastSentMessageId).toBe('m3')
      act(() => { vi.advanceTimersByTime(100) })
      expect(listProps().lastSentMessageId).toBeFalsy()
    })

    it('cancels the pending highlight timer when the view unmounts', async () => {
      vi.useFakeTimers()
      const cancelled = vi.spyOn(globalThis, 'clearTimeout')
      const { unmount } = kind.mount()
      await send('m2')
      cancelled.mockClear()
      unmount()
      expect(cancelled).toHaveBeenCalled()
      cancelled.mockRestore()
    })
  })

  it('hides the row toolbars while the user is typing', () => {
    kind.mount()
    const zone = () => document.querySelector('.focus-zone') as HTMLElement
    expect(zone()).not.toHaveClass('composer-active')
    callProp('onComposingChange', true)
    expect(zone()).toHaveClass('composer-active')
    callProp('onComposingChange', false)
    expect(zone()).not.toHaveClass('composer-active')
  })

  it('shows the toolbar of the row whose reaction picker is open and hides the others', () => {
    vi.useFakeTimers()
    kind.mount()
    fireEvent.mouseEnter(rowOf('m3').querySelector('[data-message-id]') as HTMLElement)
    act(() => { vi.advanceTimersByTime(250) })
    expect(toolbarOf('m3')).toHaveClass('opacity-100')
    fireEvent.click(toolButton(rowOf('m1'), 'smile-plus'))
    expect(toolbarOf('m1')).toHaveClass('opacity-100')
    expect(toolbarOf('m3')).toHaveClass('opacity-0')
  })

  describe('reply and edit', () => {
    it('stages a reply from a row and cancels it', () => {
      kind.mount()
      fireEvent.click(toolButton(rowOf('m1'), 'reply'))
      expect(composerProps().replyingTo).toMatchObject({ id: 'm1' })
      callProp('onCancelReply')
      expect(composerProps().replyingTo).toBeFalsy()
    })

    it('focuses the composer after a reply', () => {
      vi.useFakeTimers()
      kind.mount()
      fireEvent.click(toolButton(rowOf('m1'), 'reply'))
      act(() => { vi.advanceTimersByTime(10) })
      expect(h.focus).toHaveBeenCalled()
    })

    it('focuses the composer on every reply press in a chat, but only on a new reply target in a room', () => {
      vi.useFakeTimers()
      kind.mount()
      fireEvent.click(toolButton(rowOf('m1'), 'reply'))
      act(() => { vi.advanceTimersByTime(10) })
      const afterFirst = (h.focus as ReturnType<typeof vi.fn>).mock.calls.length
      fireEvent.click(toolButton(rowOf('m1'), 'reply'))
      act(() => { vi.advanceTimersByTime(10) })
      const second = (h.focus as ReturnType<typeof vi.fn>).mock.calls.length - afterFirst
      expect(second).toBe(kind.name === 'chat' ? 1 : 0)
    })

    it('stages an edit from a row and cancels it', () => {
      kind.mount()
      fireEvent.click(toolButton(rowOf('m2'), 'pencil'))
      expect(composerProps().editingMessage).toMatchObject({ id: 'm2' })
      callProp('onCancelEdit')
      expect(composerProps().editingMessage).toBeFalsy()
    })

    it('edits the last own message when the composer asks to', () => {
      kind.mount()
      expect(composerProps().editingMessage).toBeFalsy()
      callProp('onEditLastMessage')
      expect(composerProps().editingMessage).toMatchObject({ id: 'm2' })
    })

    it('drops a staged reply, edit and attachment when another conversation opens', () => {
      const { rerender } = kind.mount()
      fireEvent.click(toolButton(rowOf('m1'), 'reply'))
      fireEvent.click(toolButton(rowOf('m2'), 'pencil'))
      fireEvent.drop(root(), { dataTransfer: { files: [droppedFile()], types: ['Files'] } })
      expect(composerProps().replyingTo).toBeTruthy()
      expect(composerProps().editingMessage).toBeTruthy()
      expect(composerProps().pendingAttachment).toBeTruthy()

      const view = () => (kind.name === 'chat' ? <ChatView /> : <RoomView />)
      kind.activate(secondId, kind.messages())
      rerender(view())
      expect(composerProps().replyingTo).toBeFalsy()
      expect(composerProps().editingMessage).toBeFalsy()
      expect(composerProps().pendingAttachment).toBeFalsy()
      // Back in the first conversation nothing staged there comes back either.
      kind.activate(firstId, kind.messages())
      rerender(view())
      expect(composerProps().replyingTo).toBeFalsy()
      expect(composerProps().editingMessage).toBeFalsy()
    })
  })

  describe('files', () => {
    const dropTarget = () => root()

    it('shows the drop overlay while a file is dragged over the view', () => {
      kind.mount()
      expect(screen.queryByText(/drop.*upload/i)).toBeNull()
      fireEvent.dragEnter(dropTarget(), { dataTransfer: { types: ['Files'], files: [] } })
      expect(screen.getByText(/drop.*upload/i)).toBeInTheDocument()
      fireEvent.dragLeave(dropTarget(), { dataTransfer: { types: ['Files'], files: [] } })
      expect(screen.queryByText(/drop.*upload/i)).toBeNull()
    })

    it('stages a dropped file, focuses the composer and removes it on request', () => {
      vi.useFakeTimers()
      kind.mount()
      const file = droppedFile()
      fireEvent.drop(dropTarget(), { dataTransfer: { files: [file], types: ['Files'] } })
      expect(composerProps().pendingAttachment?.file).toBe(file)
      act(() => { vi.advanceTimersByTime(10) })
      expect(h.focus).toHaveBeenCalled()
      callProp('onRemovePendingAttachment')
      expect(composerProps().pendingAttachment).toBeFalsy()
    })

    it('stages a file chosen in the composer', () => {
      kind.mount()
      const file = droppedFile()
      callProp('onFileSelect', file)
      expect(composerProps().pendingAttachment?.file).toBe(file)
    })
  })

  describe('keyboard selection', () => {
    it('selects rows with the arrow keys, from the last row upward', () => {
      kind.mount()
      const zone = document.querySelector('.focus-zone') as HTMLElement
      expect(document.querySelector('[data-msg-selected]')).toBeNull()
      fireEvent.keyDown(zone, { key: 'ArrowUp' })
      expect(rowOf('m3').querySelector('[data-msg-selected]')).not.toBeNull()
      fireEvent.keyDown(zone, { key: 'ArrowUp' })
      expect(rowOf('m2').querySelector('[data-msg-selected]')).not.toBeNull()
    })

    it('starts the selection from the row under the pointer', () => {
      kind.mount()
      const zone = document.querySelector('.focus-zone') as HTMLElement
      fireEvent.mouseMove(rowOf('m1').firstElementChild ?? rowOf('m1'), { clientX: 50, clientY: 50 })
      fireEvent.keyDown(zone, { key: 'ArrowUp' })
      expect(rowOf('m1').querySelector('[data-msg-selected]')).not.toBeNull()
      expect(rowOf('m3').querySelector('[data-msg-selected]')).toBeNull()
    })

    it('forgets the selection when another conversation opens', () => {
      const { rerender } = kind.mount()
      fireEvent.keyDown(document.querySelector('.focus-zone')!, { key: 'ArrowUp' })
      expect(document.querySelector('[data-msg-selected]')).not.toBeNull()
      kind.activate(secondId, kind.messages())
      rerender(kind.name === 'chat' ? <ChatView /> : <RoomView />)
      expect(document.querySelector('[data-msg-selected]')).toBeNull()
    })
  })

  describe('find on page', () => {
    it('opens and closes from the handle the parent holds', () => {
      const ref = React.createRef<FindOnPageHandle>()
      kind.mount({ findOnPageRef: ref })
      expect(screen.queryByTitle('search.nextMatch', { exact: false })).toBeNull()
      act(() => ref.current!.open())
      expect(ref.current!.isOpen).toBe(true)
      expect(screen.getByTitle(/Next match/)).toBeInTheDocument()
      act(() => ref.current!.close())
      expect(screen.queryByTitle(/Next match/)).toBeNull()
    })

    it('marks the matching text in every row and moves the current match', () => {
      const ref = React.createRef<FindOnPageHandle>()
      kind.mount({ findOnPageRef: ref })
      act(() => ref.current!.open())
      fireEvent.change(document.querySelector('input')!, { target: { value: 'body' } })
      const marks = () => Array.from(document.querySelectorAll('.search-match'))
      const currentRow = () => document.querySelector('.search-match-current')!.closest('[data-message-row-id]')!.getAttribute('data-message-row-id')
      expect(marks()).toHaveLength(3)
      expect(document.querySelectorAll('.search-match-current')).toHaveLength(1)
      const first = currentRow()
      fireEvent.click(screen.getByTitle(/Next match/))
      expect(document.querySelectorAll('.search-match-current')).toHaveLength(1)
      expect(currentRow()).not.toBe(first)
      expect(marks()).toHaveLength(3)
    })
  })

  describe('history', () => {
    it('reports the history as complete once the SDK says so', () => {
      const active = (kind.name === 'chat' ? h.chat : h.room) as Record<string, unknown>
      active.activeHistoryState = { isLoading: false, isHistoryComplete: true }
      kind.mount()
      expect(listProps().timeline.history!.isComplete).toBe(true)
    })

    it('treats a room without archive support as complete, and a chat as not', () => {
      kind.mount()
      expect(listProps().timeline.history!.isComplete).toBeFalsy()
      if (kind.name === 'room') {
        ;(h.roomObject as { supportsMAM?: boolean }).supportsMAM = false
        kind.mount()
        expect(listProps().timeline.history!.isComplete).toBe(true)
      }
    })

    it('passes the list the history loader', () => {
      kind.mount()
      listProps().timeline.history!.onLoadOlder!()
      expect(baseActive.fetchOlderHistory).toHaveBeenCalled()
    })
  })

  describe('list signals', () => {
    it('advances the read pointer of this conversation as rows are seen', () => {
      kind.mount()
      listProps().readMarkers!.onSeen!(messageRowId(kind.messages()[0])!)
      expect(kind.sdk.advanceReadPointer).toHaveBeenCalledWith(firstId, expect.objectContaining({ id: 'm1' }))
    })

    it('clears the new-message marker of this conversation', () => {
      kind.mount()
      listProps().readMarkers!.onClear!()
      expect(kind.sdk.clearFirstNewMessageId).toHaveBeenCalledWith(firstId)
    })

    it('reports whether the reader is at the live edge, under this conversation', () => {
      kind.mount()
      listProps().readMarkers!.onLiveEdgeMeasured!(true)
      listProps().readMarkers!.onLiveEdgeMeasured!(false)
      expect(h.reportViewport).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: kind.viewportKind, entityId: firstId }), 7, 'at-edge')
      expect(h.reportViewport).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: kind.viewportKind, entityId: firstId }), 7, 'away')
    })
  })

  describe('header', () => {
    it('opens a search scoped to this conversation', () => {
      const onSearch = vi.fn()
      kind.mount({ onSearchInConversation: onSearch })
      ;(h.headerProps!.onSearchInConversation as () => void)()
      expect(onSearch).toHaveBeenCalledWith(firstId)
    })

    it('opens the saved messages of this conversation', () => {
      const onSaved = vi.fn()
      kind.mount({ onShowSavedInConversation: onSaved })
      ;(h.headerProps!.onShowSavedInConversation as () => void)()
      expect(onSaved).toHaveBeenCalledWith(firstId)
    })

    it('jumps to the first message of a chosen day in this conversation', async () => {
      const landing = kind.messages()[0]
      h.findFirstMessageOfDay.mockResolvedValue({ kind: 'found', message: { ...landing, timestamp: new Date(2024, 2, 10, 9) }, source: 'cache' })
      kind.mount()
      act(() => { (h.headerProps!.onJumpToDate as () => void)() })
      fireEvent.change(screen.getByLabelText('chat.jumpToDate.date'), { target: { value: '2024-03-10' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.go' })) })
      expect(h.findFirstMessageOfDay).toHaveBeenCalledWith(h.archiveMessages, kind.viewportKind, firstId, new Date(2024, 2, 10), new Date(2024, 2, 11),
        expect.arrayContaining([expect.objectContaining({ id: landing.id })]), undefined)
      expect(kind.storeSpies.setTargetMessageId).toHaveBeenCalledWith(
        kind.name === 'room' ? expect.objectContaining({ id: landing.id }) : landing.id)
      expect(screen.queryByLabelText('chat.jumpToDate.date')).toBeNull()
    })

    it.each(['success', 'cache read failure', 'rejection'] as const)(
      'scrolls to the latest row after an empty date lookup from a parked window on %s', async (outcome) => {
        const active = kind.name === 'chat' ? h.chat! : h.room!
        let resolveRecenter!: (result: boolean) => void
        let rejectRecenter!: (reason: Error) => void
        const recenterToLatest = vi.fn(() => new Promise<boolean>((resolve, reject) => {
          resolveRecenter = resolve
          rejectRecenter = reject
        }))
        const scrollToBottom = vi.fn()
        active.windowAtLiveEdge = false
        active.recenterToLatest = recenterToLatest
        h.findFirstMessageOfDay.mockResolvedValue({ kind: 'none' })
        kind.mount()
        const listHandleRef = (h.listProps as MessageListProps<Message>).handleRef as unknown as {
          current: { scrollToBottom: () => void } | null
        }
        listHandleRef.current = { scrollToBottom }
        act(() => { (h.headerProps!.onJumpToDate as () => void)() })
        fireEvent.change(screen.getByLabelText('chat.jumpToDate.date'), { target: { value: '2024-03-10' } })
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.go' })) })

        expect(recenterToLatest).toHaveBeenCalledOnce()
        expect(scrollToBottom).not.toHaveBeenCalled()
        expect(kind.storeSpies.setTargetMessageId).not.toHaveBeenCalled()

        await act(async () => {
          if (outcome === 'success') resolveRecenter(true)
          else if (outcome === 'cache read failure') resolveRecenter(false)
          else rejectRecenter(new Error('Cache read failed'))
          await Promise.resolve()
          await Promise.resolve()
        })
        expect(scrollToBottom).toHaveBeenCalledOnce()
      }
    )

    it('does not scroll a newly opened conversation when a parked-window recenter settles', async () => {
      const active = kind.name === 'chat' ? h.chat! : h.room!
      let finishRecenter!: (result: boolean) => void
      active.windowAtLiveEdge = false
      active.recenterToLatest = vi.fn(() => new Promise<boolean>(resolve => { finishRecenter = resolve }))
      h.findFirstMessageOfDay.mockResolvedValue({ kind: 'none' })
      const { rerender } = kind.mount()
      const listHandleRef = (h.listProps as MessageListProps<Message>).handleRef as unknown as {
        current: { scrollToBottom: () => void } | null
      }
      const originalScrollToBottom = vi.fn()
      listHandleRef.current = { scrollToBottom: originalScrollToBottom }

      act(() => { (h.headerProps!.onJumpToDate as () => void)() })
      fireEvent.change(screen.getByLabelText('chat.jumpToDate.date'), { target: { value: '2024-03-10' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.go' })) })

      kind.activate(secondId, kind.messages())
      rerender(kind.name === 'chat' ? <ChatView /> : <RoomView />)
      const nextScrollToBottom = vi.fn()
      listHandleRef.current = { scrollToBottom: nextScrollToBottom }
      await act(async () => {
        finishRecenter(true)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(originalScrollToBottom).not.toHaveBeenCalled()
      expect(nextScrollToBottom).not.toHaveBeenCalled()
    })

    it('uses local history only when a chat server is known not to offer MAM', async () => {
      if (kind.name !== 'chat') return
      h.serverInfo = { features: [] }
      h.findFirstMessageOfDay.mockResolvedValue({ kind: 'unknown' })
      const unsupported = kind.mount()
      act(() => { (h.headerProps!.onJumpToDate as () => void)() })
      fireEvent.change(screen.getByLabelText('chat.jumpToDate.date'), { target: { value: '2024-03-10' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.go' })) })
      expect(h.findFirstMessageOfDay.mock.calls[0][0]).toBeUndefined()

      unsupported.unmount()
      h.findFirstMessageOfDay.mockClear()
      h.serverInfo = null
      kind.mount()
      act(() => { (h.headerProps!.onJumpToDate as () => void)() })
      fireEvent.change(screen.getByLabelText('chat.jumpToDate.date'), { target: { value: '2024-03-10' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.go' })) })
      expect(h.findFirstMessageOfDay.mock.calls[0][0]).toBe(h.archiveMessages)
    })

    it('does not land a pending date lookup after switching conversations', async () => {
      let resolve!: (result: unknown) => void
      h.findFirstMessageOfDay.mockReturnValueOnce(new Promise((done) => { resolve = done }))
      const { rerender } = kind.mount()
      act(() => { (h.headerProps!.onJumpToDate as () => void)() })
      fireEvent.change(screen.getByLabelText('chat.jumpToDate.date'), { target: { value: '2024-03-10' } })
      fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.go' }))
      expect(h.findFirstMessageOfDay).toHaveBeenCalled()
      kind.activate(secondId, kind.messages())
      rerender(kind.name === 'chat' ? <ChatView /> : <RoomView />)
      expect(screen.queryByLabelText('chat.jumpToDate.date')).toBeNull()
      await act(async () => resolve({ kind: 'found', message: kind.messages()[0], source: 'archive' }))
      expect(kind.storeSpies.setTargetMessageId).not.toHaveBeenCalled()
    })

    // Approved day-pill plan: cancel restores a visible opener, not a stale or hidden row.
    it.each(['visible', 'outside viewport', 'removed'] as const)('restores usable focus when the date opener is %s', (state) => {
      document.documentElement.setAttribute('data-motion', 'reduced')
      try {
        kind.mount()
        const pill = document.querySelector<HTMLElement>('[data-date-pill]')!
        const rect = { x: 100, y: 100, top: 100, left: 100, right: 200, bottom: 126, width: 100, height: 26, toJSON() {} }
        vi.spyOn(pill, 'getBoundingClientRect').mockImplementation(() => rect)
        fireEvent.click(pill)
        expect(screen.getByRole('dialog', { name: 'chat.jumpToDate.title' })).toBeInTheDocument()
        expect(screen.getByLabelText('chat.jumpToDate.date')).toHaveFocus()
        expect(h.findFirstMessageOfDay).not.toHaveBeenCalled()
        if (state === 'outside viewport') { rect.top = -100; rect.bottom = -74 }
        if (state === 'removed') pill.remove()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(state === 'visible' ? pill : screen.getByRole('button', { name: 'Conversation actions' })).toHaveFocus()
        expect(kind.storeSpies.setTargetMessageId).not.toHaveBeenCalled()
      } finally { document.documentElement.removeAttribute('data-motion') }
    })

    it('returns menu cancellation to actions and a completed jump to the message area', async () => {
      document.documentElement.setAttribute('data-motion', 'reduced')
      try {
        h.findFirstMessageOfDay.mockResolvedValue({ kind: 'found', message: kind.messages()[0], source: 'cache' })
        kind.mount()
        const actions = screen.getByRole('button', { name: 'Conversation actions' })
        actions.focus()
        act(() => { (h.headerProps!.onJumpToDate as () => void)() })
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(actions).toHaveFocus()
        act(() => { (h.headerProps!.onJumpToDate as () => void)() })
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'chat.jumpToDate.go' })) })
        expect(document.querySelector('[data-date-focus-target]')).toHaveFocus()
      } finally { document.documentElement.removeAttribute('data-motion') }
    })

    // Approved stacked-dialog contract: a completed lookup cannot steal foreground focus.
    it('leaves focus in a modal opened above a pending date lookup', async () => {
      document.documentElement.setAttribute('data-motion', 'reduced')
      let resolve!: (result: unknown) => void
      h.findFirstMessageOfDay.mockReturnValueOnce(new Promise(done => { resolve = done }))
      kind.mount()
      act(() => { (h.headerProps!.onJumpToDate as () => void)() })
      fireEvent.submit(screen.getByLabelText('chat.jumpToDate.date').closest('form')!)
      const foreground = document.createElement('div')
      foreground.dataset.modal = 'true'
      const input = document.createElement('input')
      foreground.append(input)
      document.body.append(foreground)
      const focusMessages = vi.spyOn(document.querySelector<HTMLElement>('[data-date-focus-target]')!, 'focus')
      try {
        input.focus()
        await act(async () => resolve({ kind: 'found', message: kind.messages()[0], source: 'archive' }))
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(input).toHaveFocus()
        expect(focusMessages).not.toHaveBeenCalled()
        expect(kind.storeSpies.setTargetMessageId).toHaveBeenCalled()
      } finally {
        foreground.remove()
        document.documentElement.removeAttribute('data-motion')
      }
    })

    // The approved picker outcome must survive a foreground modal opened during dismissal.
    it.each([
      ['Escape', 'visible', 'pill'],
      ['Close', 'visible', 'pill'],
      ['backdrop', 'visible', 'pill'],
      ['Escape', 'clipped', 'actions'],
      ['Escape', 'removed', 'actions'],
      ['jump', 'visible', 'messages'],
      ['jump', 'switched', 'none'],
      ['jump', 'covered', 'none'],
      ['jump', 'foreground', 'none'],
    ] as const)('restores %s with a %s opener after the foreground closes', async (outcome, state, expected) => {
      document.documentElement.setAttribute('data-motion', 'full')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let resolve!: (result: unknown) => void
      if (outcome === 'jump') h.findFirstMessageOfDay.mockReturnValueOnce(new Promise(done => { resolve = done }))
      const view = kind.mount()
      const pill = document.querySelector<HTMLElement>('[data-date-pill]')!
      const rect = { x: 100, y: 100, top: 100, left: 100, right: 200, bottom: 126, width: 100, height: 26, toJSON() {} }
      vi.spyOn(pill, 'getBoundingClientRect').mockImplementation(() => rect)
      fireEvent.click(pill)
      if (outcome === 'jump') fireEvent.submit(screen.getByLabelText('chat.jumpToDate.date').closest('form')!)
      else if (outcome === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
      else if (outcome === 'Close') fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
      else fireEvent.click(document.querySelector('[data-modal] > button')!)
      expect(screen.getByRole('dialog', { name: 'chat.jumpToDate.title' })).toBeInTheDocument()
      const foreground = render(<ModalOverlay onClose={() => {}}><input aria-label="Search conversations" /></ModalOverlay>)
      const input = foreground.container.querySelector('input')!
      const other = document.createElement('div')
      try {
        expect(input).toHaveFocus()
        if (outcome === 'jump') await act(async () => resolve({ kind: 'found', message: kind.messages()[0], source: 'archive' }))
        else act(() => vi.advanceTimersByTime(MODAL_EXIT_MS))
        expect(screen.queryByRole('dialog', { name: 'chat.jumpToDate.title' })).toBeNull()
        expect(input).toHaveFocus()
        if (state === 'clipped') { rect.top = -100; rect.bottom = -74 }
        if (state === 'removed') pill.remove()
        if (state === 'switched') {
          kind.activate(secondId, kind.messages())
          view.rerender(kind.name === 'chat' ? <ChatView /> : <RoomView />)
        }
        if (state === 'covered') document.querySelector('[data-conversation-thread]')!.setAttribute('inert', '')
        if (state === 'foreground') {
          other.dataset.modal = 'true'
          other.innerHTML = '<input aria-label="Another search">'
          document.body.append(other)
          other.querySelector('input')!.focus()
        }
        const messages = document.querySelector<HTMLElement>('[data-date-focus-target]')!
        const focusMessages = vi.spyOn(messages, 'focus')
        await act(async () => { foreground.unmount() })
        if (expected === 'pill') expect(pill).toHaveFocus()
        else if (expected === 'actions') expect(screen.getByRole('button', { name: 'Conversation actions' })).toHaveFocus()
        else if (expected === 'messages') expect(messages).toHaveFocus()
        else expect(focusMessages).not.toHaveBeenCalled()
        if (state === 'foreground') expect(other.querySelector('input')).toHaveFocus()
        if (outcome !== 'jump') expect(kind.storeSpies.setTargetMessageId).not.toHaveBeenCalled()
      } finally {
        foreground.unmount()
        other.remove()
        vi.useRealTimers()
        document.documentElement.removeAttribute('data-motion')
      }
    })

    it('does not restore old-dialog focus after a conversation switch', () => {
      const { rerender } = kind.mount()
      const actions = screen.getByRole('button', { name: 'Conversation actions' })
      actions.focus()
      const focus = vi.spyOn(actions, 'focus')
      act(() => { (h.headerProps!.onJumpToDate as () => void)() })
      focus.mockClear()
      kind.activate(secondId, kind.messages())
      rerender(kind.name === 'chat' ? <ChatView /> : <RoomView />)
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(focus).not.toHaveBeenCalled()
    })

    it('opens jump to date on the day of a date bubble', () => {
      kind.mount()
      act(() => { listProps().timeline.window!.onJumpToDate!('2024-03-10') })
      expect((screen.getByLabelText('chat.jumpToDate.date') as HTMLInputElement).value).toBe('2024-03-10')
    })

    it('offers neither when the parent gives no handler', () => {
      kind.mount()
      expect(h.headerProps!.onSearchInConversation).toBeUndefined()
      expect(h.headerProps!.onShowSavedInConversation).toBeUndefined()
    })
  })

  describe('mentions above the composer', () => {
    it('jumps to the reacted message from its pill', () => {
      reactionMentionStore.getState().addMention({ id: 'r1', conversationId: firstId, messageId: 'm1', reactorName: 'Alice', emoji: '👍', preview: 'hi' })
      kind.mount()
      const pill = screen.getByRole('button', { name: 'See' })
      fireEvent.click(pill)
      expect(kind.storeSpies.setTargetMessageId).toHaveBeenCalledWith('m1')
    })

    it('forgets this conversation\'s reaction pills when it is left', () => {
      reactionMentionStore.getState().addMention({ id: 'r1', conversationId: firstId, messageId: 'm1', reactorName: 'Alice', emoji: '👍', preview: 'hi' })
      const { unmount } = kind.mount()
      expect(reactionMentionStore.getState().mentions.has(firstId)).toBe(true)
      unmount()
      expect(reactionMentionStore.getState().mentions.has(firstId)).toBe(false)
    })

    it('plays a pending easter egg once when its conversation opens, and replays it on request', () => {
      easterEggMentionStore.getState().add({ id: 'e1', conversationId: firstId, animation: 'confetti', senderName: 'Alice' })
      kind.mount()
      expect(kind.storeSpies.triggerAnimation).toHaveBeenCalledTimes(1)
      expect(kind.storeSpies.triggerAnimation).toHaveBeenCalledWith(firstId, 'confetti', 'Alice')
      expect(easterEggMentionStore.getState().mentions.get(firstId)?.played).toBe(true)
      kind.storeSpies.triggerAnimation.mockClear()
      fireEvent.click(within(document.body).getByText(/replay/i))
      expect(kind.storeSpies.triggerAnimation).toHaveBeenCalledWith(firstId, 'confetti', 'Alice')
    })

    it('does not replay an egg that already played when the view mounts again', () => {
      easterEggMentionStore.getState().add({ id: 'e1', conversationId: firstId, animation: 'confetti', senderName: 'Alice' })
      easterEggMentionStore.getState().markPlayed(firstId)
      kind.mount()
      expect(kind.storeSpies.triggerAnimation).not.toHaveBeenCalled()
    })
  })

  describe('type to focus', () => {
    it('focuses the composer when the user types outside a field', () => {
      kind.mount()
      fireEvent.keyDown(document.body, { key: 'a' })
      expect(h.focus).toHaveBeenCalled()
    })

    it('leaves a modifier shortcut alone', () => {
      kind.mount()
      fireEvent.keyDown(document.body, { key: 'a', metaKey: true })
      expect(h.focus).not.toHaveBeenCalled()
    })
  })

  it('animates the easter egg of this conversation only', () => {
    const own = kind.name === 'chat' ? { conversationId: firstId } : { roomJid: firstId }
    const other = kind.name === 'chat' ? { conversationId: secondId } : { roomJid: secondId }
    const active = (kind.name === 'chat' ? h.chat : h.room) as Record<string, unknown>
    active.activeAnimation = { ...other, animation: 'confetti', senderName: 'Alice' }
    kind.mount()
    expect(screen.queryByTestId('easter-egg-animation')).toBeNull()
    active.activeAnimation = { ...own, animation: 'confetti', senderName: 'Alice' }
    kind.mount()
    expect(screen.getByTestId('easter-egg-animation')).toBeInTheDocument()
  })

  it('hands the composer one stable callback set across re-renders', () => {
    const { rerender } = kind.mount()
    const before = composerProps()
    rerender(kind.name === 'chat' ? <ChatView /> : <RoomView />)
    const after = composerProps()
    for (const name of ['onCancelReply', 'onCancelEdit', 'onEditLastMessage', 'onComposingChange', 'onFileSelect', 'onRemovePendingAttachment']) {
      expect(after[name], name).toBe(before[name])
    }
  })

})
