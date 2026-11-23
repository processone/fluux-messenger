import type { ReactNode, Ref } from 'react'
import type { BaseMessage, GapInterval, MessageRowRef } from '@fluux/sdk'
import type { CopyMessageMeta } from '@/utils/buildCopyText'
import type { ViewportMetrics } from '@/utils/viewportMetrics'

/**
 * The boundary between a conversation view and the message list.
 *
 * A view reaches the list through four objects and nothing else: the data it shows
 * (`timeline`), what the reader has and has not read (`readMarkers`), one jump request
 * (`target`) and a command handle (`MessageListHandle`) the list fills in once mounted.
 * No scroll element and no at-bottom flag crosses: the list owns both, and a view that
 * needs an answer about them asks the handle.
 */

/** Everything the list renders, and the loaders it calls to extend it. */
export interface ConversationTimeline<T extends BaseMessage> {
  /** Messages to display. */
  messages: T[]
  /** SDK message-event progress; remains unchanged during local read/scroll work. */
  ingressVersion?: number
  /** Bumped when rows change height in place (a window slid, a row's interior was replaced). */
  interiorPlacementVersion?: number
  /** Older history: the trigger to fetch it and the state that gates the trigger. */
  history?: {
    /** Called when the reader scrolls to the top. Omitted: no load-earlier trigger. */
    onLoadOlder?: () => void
    isLoadingOlder?: boolean
    /** All history has been fetched: the load-earlier trigger is disabled. */
    isComplete?: boolean
    /** The last archive fetch failed: the top of the list says the thread may be incomplete. */
    unavailable?: boolean
    /**
     * Hydrate the resident window with the cache slice CONTAINING a message. Used by
     * scroll-position restore and target navigation when the anchor is older than the
     * latest slice loaded on activation.
     */
    onLoadAround?: (anchorRow: MessageRowRef, signal?: AbortSignal) => Promise<unknown> | void
  }
  /** Sliding window: where the resident messages sit relative to the newest message. */
  window?: {
    /** false = slid up (enables the load-newer trigger); absent/true = at the live edge. */
    atLiveEdge?: boolean
    onLoadNewer?: () => void
    isLoadingNewer?: boolean
    /** Reset the window to the newest slice; the scroll-to-bottom button calls it when slid up. */
    onJumpToLatest?: () => Promise<unknown> | void
    /** Opens jump to date at a day (`yyyy-MM-dd`); makes the date pills buttons. */
    onJumpToDate?: (date: string) => void
  }
  /** Recorded history gaps, oldest first, and the action that fills one. */
  gaps?: {
    intervals?: readonly GapInterval[]
    onCatchUp?: (gapStart: number) => void
    isCatchingUp?: boolean
  }
}

/** The reader's read state as the list shows it: divider, counts and the read pointer. */
export interface ReadMarkers {
  /** Row reference of the first unread message (the new-message divider). */
  firstNewRow?: MessageRowRef
  /** The divider was derived while a synced read position is unresolved — rendered muted. */
  firstNewIsProvisional?: boolean
  /**
   * How many messages sit under the divider. Labels the divider and the jump-to-last-read
   * pill. Undefined falls back to `unreadCount`.
   */
  firstNewCount?: number
  /** Persisted read pointer — the badge counts unread below it. */
  readPointerRow?: MessageRowRef
  /** The canonical unread count; no surface recomputes it from the resident array. */
  unreadCount?: number
  /** Called when the bottom-most visible row changes; receives its row handle. */
  onSeen?: (rowId: string) => void
  /** Clear the first-new row marker (used by the viewport observer). */
  onClear?: () => void
  /**
   * Live-edge evidence from real measured geometry, or its revocation when a deliberate
   * interaction holds the view. A true report is never an assumed default.
   */
  onLiveEdgeMeasured?: (atEdge: boolean) => void
}

/** One request to scroll to a message (activity-log click, search result, saved message). */
export interface MessageTargetRequest {
  id: string | MessageRowRef | null | undefined
  /** Called once the list has handled the request, so the view can clear its stored value. */
  onConsumed?: () => void
}

/** The commands a view may issue to its list, and the questions it may ask. */
export interface MessageListHandle {
  /** Submit an explicit message target to the list's positioning controller. */
  requestMessageTarget(id: string | MessageRowRef): void
  /** Scroll to the newest message (same action as the ⌘/Ctrl+↓ shortcut and the FAB). */
  scrollToBottom(): void
  /**
   * Tell the list a keyboard selection is moving the view. `'start'` (the default) is the key
   * press: the reader leaves the live edge and the scrollbar reveals. `'scrolled'` follows once
   * the selected row has been scrolled into view.
   */
  noteKeyboardNavigation(phase?: 'start' | 'scrolled'): void
  /** Is the newest message on screen? `false` for a list that is not mounted. */
  isAtBottom(): boolean
  /** The handle of the lowest row overlapping the viewport, or null when none is mounted. */
  lastVisibleRowId(): string | null
  /** Does this node sit inside the list's scrolling content? */
  contains(node: Node | null): boolean
  /** An independent geometry reading of the viewport, for dev-only anomaly detectors. */
  measureViewport(): ViewportMetrics | null
}

/** A ref the view holds so it can issue commands once the list has mounted. */
export type MessageListHandleRef = Ref<MessageListHandle>

/** The same handle ref as read from the view's side (`current` is null until mounted). */
export type MessageListHandleCurrent = { readonly current: MessageListHandle | null }

/**
 * A static preview (search context, saved message, stranger request). Static lists render every
 * row, never auto-scroll, and stay outside the positioning controller.
 */
export interface StaticRows<T extends BaseMessage> {
  /** Previews may override row handles, React keys and deduplication. Must match scroll targets. */
  getId?: (message: T) => string
  /**
   * Land one row ~1/3 down the viewport and keep it highlighted. A new `key` restarts the landing;
   * `holding` delays it until the preview's context is ready.
   */
  landOn?: { rowId: string | undefined; key: unknown; holding?: boolean }
}

export interface MessageListProps<T extends BaseMessage> {
  /** Unique identifier for this conversation/room. */
  conversationId: string
  timeline: ConversationTimeline<T>
  /** Focused, measured viewport evidence only; static previews never call this. */
  onFocusedVisibleRows?: (rows: readonly T[]) => void
  readMarkers?: ReadMarkers
  target?: MessageTargetRequest
  /** Filled with the command handle while the list is mounted. */
  handleRef?: MessageListHandleRef
  /**
   * Render function for each message. Pass `onMediaLoad` to image/video components so batched
   * scroll correction runs when media loads.
   */
  renderMessage: (message: T, index: number, groupMessages: T[], showNewMarker: boolean, onMediaLoad: () => void) => ReactNode
  /**
   * Maps a message to its clipboard metadata, faithful to the rendered bubble. Consumed on the
   * virtualized path: a multi-message copy is rebuilt from the in-memory array.
   */
  formatMessageForCopy?: (message: T) => CopyMessageMeta
  /** Users currently typing, and how to display one. */
  typing?: { users: string[]; format?: (user: string) => string }
  /** ID of the last message sent by the user (for send animation). */
  lastSentMessageId?: string | null
  /** Shown instead of the list while the first load runs. */
  loading?: ReactNode
  /** Shown when there are no messages. */
  emptyState?: ReactNode
  /** Extra content rendered after all messages. */
  extraContent?: ReactNode
  /** Present for a static preview; absent for a live list. */
  staticRows?: StaticRows<T>
}
