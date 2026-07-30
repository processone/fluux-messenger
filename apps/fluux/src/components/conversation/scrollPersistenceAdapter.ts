import {
  scrollStateManager,
  type ScrollAnchor,
} from '@/utils/scrollStateManager'
import type { ViewportSessionSnapshot } from './viewportSession'

export type ScrollEntryAction =
  | 'scroll-to-bottom'
  | 'restore-position'
  | 'no-action'

export interface ScrollPersistenceEntry {
  firstOpenThisSession: boolean
  action: ScrollEntryAction
  savedOffsetPx: number | null
  savedAnchor: ScrollAnchor | null
  savedReadPositionId: string | undefined
}

export interface ScrollPersistenceStore {
  isInitialized(conversationId: string): boolean
  enterConversation(
    conversationId: string,
    messageCount: number,
  ): ScrollEntryAction
  getSavedScrollTop(conversationId: string): number | null
  getSavedAnchor(conversationId: string): ScrollAnchor | null
  getSavedReadPositionId(conversationId: string): string | undefined
  saveScrollPosition(
    conversationId: string,
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    anchor?: ScrollAnchor,
    readPositionId?: string,
  ): void
  leaveConversation(
    conversationId: string,
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number,
    anchor?: ScrollAnchor,
    readPositionId?: string,
  ): void
  markAsLeft(conversationId: string): void
  clearSavedScrollState(conversationId: string): void
}

export interface PersistViewportFacts {
  conversationId: string
  snapshot: ViewportSessionSnapshot | null
  readPositionId: string | undefined
  controllerOwnsPixels: boolean
  now: number
}

export type LeaveConversationOutcome = 'saved' | 'marked-left'

const DEFAULT_SAVE_THROTTLE_MS = 100

/**
 * Conversation persistence policy for the live viewport.
 *
 * The adapter consumes immutable viewport-session snapshots and owns no DOM, virtualizer, frame,
 * or pixel-write capability. ScrollStateManager remains the in-memory store; this boundary owns
 * when the hook may enter, save, leave, or clear it.
 */
export class ScrollPersistenceAdapter {
  private lastSaveAt = 0

  constructor(
    private readonly store: ScrollPersistenceStore = scrollStateManager,
    private readonly saveThrottleMs = DEFAULT_SAVE_THROTTLE_MS,
  ) {}

  enterConversation(
    conversationId: string,
    messageCount: number,
  ): ScrollPersistenceEntry {
    const firstOpenThisSession = !this.store.isInitialized(conversationId)
    const action = this.store.enterConversation(conversationId, messageCount)
    return {
      firstOpenThisSession,
      action,
      savedOffsetPx: this.store.getSavedScrollTop(conversationId),
      savedAnchor: this.store.getSavedAnchor(conversationId),
      savedReadPositionId:
        this.store.getSavedReadPositionId(conversationId),
    }
  }

  persistViewport(facts: PersistViewportFacts): boolean {
    const { snapshot } = facts
    if (
      facts.controllerOwnsPixels ||
      snapshot?.conversationId !== facts.conversationId ||
      !snapshot.geometry ||
      !snapshot.hasGenuineInput ||
      facts.now - this.lastSaveAt <= this.saveThrottleMs
    ) {
      return false
    }

    const { top, height, client } = snapshot.geometry
    this.lastSaveAt = facts.now
    this.store.saveScrollPosition(
      facts.conversationId,
      top,
      height,
      client,
      snapshot.bottomAnchor ?? undefined,
      facts.readPositionId,
    )
    return true
  }

  leaveConversation(
    conversationId: string,
    snapshot: ViewportSessionSnapshot | null,
    readPositionId: string | undefined,
  ): LeaveConversationOutcome {
    if (
      snapshot?.conversationId === conversationId &&
      snapshot.geometry &&
      snapshot.hasGenuineInput
    ) {
      const { top, height, client } = snapshot.geometry
      this.store.leaveConversation(
        conversationId,
        top,
        height,
        client,
        snapshot.bottomAnchor ?? undefined,
        readPositionId,
      )
      return 'saved'
    }

    this.store.markAsLeft(conversationId)
    return 'marked-left'
  }

  clearSavedPosition(conversationId: string): void {
    this.store.clearSavedScrollState(conversationId)
  }
}
