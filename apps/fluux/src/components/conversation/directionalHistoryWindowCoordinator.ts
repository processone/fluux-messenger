export const DIRECTIONAL_HISTORY_COOLDOWN_MS = 500

export type DirectionalHistoryDirection = 'older' | 'newer'
export type DirectionalHistoryLoadMode = 'automatic' | 'explicit'

export interface DirectionalHistoryCapture {
  anchorMessageId: string
  anchorOffsetFromTop: number
  distanceFromBottom: number
  firstMessageId: string
  messageCount: number
}

export interface DirectionalHistorySnapshot {
  requestId: number
  conversationId: string
  direction: DirectionalHistoryDirection
  anchorMessageId: string
  anchorOffsetFromTop: number
  distanceFromBottom: number
  oldFirstId: string
  oldMessageCount: number
  generation?: number
  restored: boolean
  restoredAt?: number
  loadSettled: boolean
  /**
   * First message id the latest restore was started for. A different first id while the load is
   * still in flight means the window shifted again after that restore: at the resident bound an
   * interior arrival evicts the oldest row, so the batch can land after the restore it started.
   */
  restoredFirstId?: string
  /**
   * Where this load's restore placed its anchor: where the reader last saw it, which differs from
   * the capture when the reader scrolled on while the load was pending. A restart of the same load
   * places it there again, since the reader has not moved since that restore.
   */
  placementOffsetFromTop?: number
}

export interface BeginDirectionalHistoryInput {
  conversationId: string
  direction: DirectionalHistoryDirection
  mode: DirectionalHistoryLoadMode
  now: number
  loaderAvailable: boolean
  loading: boolean
  historyComplete: boolean
  windowAtLiveEdge: boolean
  travelledAway: boolean
  capture: () => DirectionalHistoryCapture
}

export type DirectionalHistoryBlockReason =
  | 'unavailable'
  | 'loading'
  | 'history-complete'
  | 'live-edge'
  | 'cooldown'
  | 'recently-restored'

export type BeginDirectionalHistoryResult =
  | {
      kind: 'started'
      snapshot: DirectionalHistorySnapshot
      clearTravel: boolean
    }
  | { kind: 'blocked'; reason: DirectionalHistoryBlockReason }

export type DirectionalHistoryReleaseDecision =
  | { kind: 'none' }
  | { kind: 'cleared'; snapshot: DirectionalHistorySnapshot }
  | {
      kind: 'cancel'
      snapshot: DirectionalHistorySnapshot
      generation: number
    }

export type DirectionalHistoryWindowDecision =
  | { kind: 'none' }
  | { kind: 'waiting'; snapshot: DirectionalHistorySnapshot }
  | { kind: 'dropped'; snapshot: DirectionalHistorySnapshot }
  | {
      kind: 'reconcile'
      snapshot: DirectionalHistorySnapshot
      generation: number
    }
  /** The window shifted again after a restore, before its load settled: restore it once more. */
  | { kind: 'restart'; snapshot: DirectionalHistorySnapshot }

/**
 * Whether the reader still reads where the restore holding `generation` put them: nothing they did
 * or asked for has moved them since. Answered by the positioning controller.
 */
export type DirectionalHistoryReadingHeld = (generation: number) => boolean

/** Value-only policy owner for directional history window loads. */
export class DirectionalHistoryWindowCoordinator {
  private nextRequestId = 1
  private lastLoadAt = 0
  private lastRestoreAt: number | null = null
  private currentConversationId: string | null = null
  private previousWindowAtLiveEdge: boolean | undefined = true
  private active: DirectionalHistorySnapshot | null = null

  constructor(
    private readonly cooldownMs = DIRECTIONAL_HISTORY_COOLDOWN_MS,
  ) {}

  begin(input: BeginDirectionalHistoryInput): BeginDirectionalHistoryResult {
    if (!input.loaderAvailable) {
      return { kind: 'blocked', reason: 'unavailable' }
    }
    if (input.loading) return { kind: 'blocked', reason: 'loading' }
    if (input.direction === 'older' && input.historyComplete) {
      return { kind: 'blocked', reason: 'history-complete' }
    }
    if (input.direction === 'newer' && input.windowAtLiveEdge) {
      return { kind: 'blocked', reason: 'live-edge' }
    }
    if (
      input.mode === 'automatic' &&
      input.direction === 'older' &&
      this.lastRestoreAt !== null &&
      input.now - this.lastRestoreAt < this.cooldownMs
    ) {
      return { kind: 'blocked', reason: 'recently-restored' }
    }
    if (
      input.mode === 'automatic' &&
      input.now - this.lastLoadAt <= this.cooldownMs &&
      !input.travelledAway
    ) {
      return { kind: 'blocked', reason: 'cooldown' }
    }

    this.lastLoadAt = input.now
    const capture = input.capture()
    const snapshot: DirectionalHistorySnapshot = {
      requestId: this.nextRequestId++,
      conversationId: input.conversationId,
      direction: input.direction,
      anchorMessageId: capture.anchorMessageId,
      anchorOffsetFromTop: capture.anchorOffsetFromTop,
      distanceFromBottom: capture.distanceFromBottom,
      oldFirstId: capture.firstMessageId,
      oldMessageCount: capture.messageCount,
      restored: false,
      loadSettled: false,
    }
    if (this.currentConversationId !== input.conversationId) {
      this.currentConversationId = input.conversationId
      this.previousWindowAtLiveEdge = input.windowAtLiveEdge
    }
    this.active = snapshot
    return {
      kind: 'started',
      snapshot,
      clearTravel: input.mode === 'automatic',
    }
  }

  enterConversation(
    conversationId: string,
    windowAtLiveEdge: boolean | undefined,
  ): void {
    this.currentConversationId = conversationId
    this.previousWindowAtLiveEdge = windowAtLiveEdge
    this.active = null
  }

  suppressAutomaticLoads(now: number): void {
    this.lastLoadAt = now
  }

  attachGeneration(requestId: number, generation: number): boolean {
    if (this.active?.requestId !== requestId) return false
    this.active.generation = generation
    return true
  }

  activeSnapshot(conversationId: string): DirectionalHistorySnapshot | null {
    return this.currentConversationId === conversationId
      ? this.active
      : null
  }

  isPendingWindowShift(
    conversationId: string,
    firstMessageId: string,
    readingHeld: DirectionalHistoryReadingHeld,
  ): boolean {
    const snapshot = this.activeSnapshot(conversationId)
    if (!snapshot) return false
    if (!snapshot.restored) return snapshot.oldFirstId !== firstMessageId
    return this.shiftedAfterRestore(snapshot, firstMessageId, readingHeld)
  }

  /** A restored load still in flight whose window shifted again, while the reader stayed put. */
  private shiftedAfterRestore(
    snapshot: DirectionalHistorySnapshot,
    firstMessageId: string,
    readingHeld: DirectionalHistoryReadingHeld,
  ): boolean {
    return (
      !snapshot.loadSettled &&
      snapshot.restoredFirstId !== firstMessageId &&
      snapshot.generation !== undefined &&
      readingHeld(snapshot.generation)
    )
  }

  markLoadSettled(requestId: number): boolean {
    if (this.active?.requestId !== requestId) return false
    this.active.loadSettled = true
    return true
  }

  invokeLoad(
    snapshot: DirectionalHistorySnapshot,
    run: () => unknown,
    onSettled: (requestId: number) => void,
  ): void {
    let didSettle = false
    const settle = () => {
      if (didSettle) return
      didSettle = true
      this.markLoadSettled(snapshot.requestId)
      onSettled(snapshot.requestId)
    }

    let result: unknown
    try {
      result = run()
    } catch (error) {
      settle()
      throw error
    }
    const thenable = result as PromiseLike<unknown> | null | undefined
    if (typeof thenable?.then === 'function') {
      thenable.then(settle, settle)
    } else {
      settle()
    }
  }

  releaseSettledWithoutShift(input: {
    requestId: number
    conversationId: string
    firstMessageId: string
  }): DirectionalHistoryReleaseDecision {
    const snapshot = this.active
    if (
      !snapshot ||
      snapshot.requestId !== input.requestId ||
      snapshot.conversationId !== input.conversationId ||
      this.currentConversationId !== input.conversationId ||
      !snapshot.loadSettled
    ) {
      return { kind: 'none' }
    }
    if (snapshot.restored) {
      // Its batch has landed and been restored; nothing more can shift for this load.
      this.active = null
      return { kind: 'cleared', snapshot }
    }
    if (snapshot.oldFirstId !== input.firstMessageId) return { kind: 'none' }
    if (snapshot.generation === undefined) {
      this.active = null
      return { kind: 'cleared', snapshot }
    }
    return {
      kind: 'cancel',
      snapshot,
      generation: snapshot.generation,
    }
  }

  observeLiveEdge(
    conversationId: string,
    windowAtLiveEdge: boolean | undefined,
  ): DirectionalHistoryReleaseDecision {
    if (this.currentConversationId !== conversationId) {
      this.enterConversation(conversationId, windowAtLiveEdge)
      return { kind: 'none' }
    }
    const returnedToLiveEdge =
      this.previousWindowAtLiveEdge === false && windowAtLiveEdge === true
    this.previousWindowAtLiveEdge = windowAtLiveEdge
    const snapshot = this.active
    if (
      !returnedToLiveEdge ||
      !snapshot ||
      snapshot.conversationId !== conversationId ||
      snapshot.restored
    ) {
      return { kind: 'none' }
    }
    if (snapshot.generation === undefined) {
      this.active = null
      return { kind: 'cleared', snapshot }
    }
    return {
      kind: 'cancel',
      snapshot,
      generation: snapshot.generation,
    }
  }

  observeWindow(input: {
    conversationId: string
    firstMessageId: string
    readingHeld: DirectionalHistoryReadingHeld
  }): DirectionalHistoryWindowDecision {
    const snapshot = this.active
    if (
      !snapshot ||
      snapshot.conversationId !== input.conversationId ||
      this.currentConversationId !== input.conversationId
    ) {
      return { kind: 'none' }
    }
    if (snapshot.restored) {
      // An in-flight load owns its batch until the load settles, even when an eviction at the
      // resident bound already shifted the window and spent the first restore (FLM-204). The
      // reader moving on since that restore releases it instead.
      if (
        snapshot.loadSettled ||
        snapshot.restoredFirstId === input.firstMessageId
      ) {
        return { kind: 'none' }
      }
      if (
        !this.shiftedAfterRestore(snapshot, input.firstMessageId, input.readingHeld)
      ) {
        this.active = null
        return { kind: 'dropped', snapshot }
      }
      snapshot.restoredFirstId = input.firstMessageId
      return { kind: 'restart', snapshot }
    }
    if (snapshot.oldFirstId === input.firstMessageId) {
      return { kind: 'waiting', snapshot }
    }
    if (snapshot.generation === undefined) {
      this.active = null
      return { kind: 'dropped', snapshot }
    }
    snapshot.restoredFirstId = input.firstMessageId
    return {
      kind: 'reconcile',
      snapshot,
      generation: snapshot.generation,
    }
  }

  /** Remember where a restore of this load placed its anchor, for a restart of the same load. */
  recordPlacement(requestId: number, offsetFromTop: number): void {
    if (this.active?.requestId === requestId) {
      this.active.placementOffsetFromTop = offsetFromTop
    }
  }

  markRestored(
    requestId: number,
    now: number,
  ): DirectionalHistorySnapshot | null {
    if (this.active?.requestId !== requestId) return null
    this.active.restored = true
    this.active.restoredAt = now
    this.lastRestoreAt = now
    return this.active
  }

  finishPosition(requestId: number): void {
    if (
      this.active?.requestId === requestId &&
      !this.active.restored
    ) {
      this.active = null
    }
  }

  /** Clears a restore after its cooldown, unless its load is still in flight and may yet land. */
  expireRestored(requestId: number, restoredAt: number): void {
    if (
      this.active?.requestId === requestId &&
      this.active.restoredAt === restoredAt &&
      this.active.loadSettled
    ) {
      this.active = null
    }
  }
}
