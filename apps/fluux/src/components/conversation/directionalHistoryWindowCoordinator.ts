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
  ): boolean {
    const snapshot = this.activeSnapshot(conversationId)
    return Boolean(
      snapshot &&
      !snapshot.restored &&
      snapshot.oldFirstId !== firstMessageId,
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
      snapshot.restored ||
      !snapshot.loadSettled ||
      snapshot.oldFirstId !== input.firstMessageId
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
  }): DirectionalHistoryWindowDecision {
    const snapshot = this.active
    if (
      !snapshot ||
      snapshot.conversationId !== input.conversationId ||
      this.currentConversationId !== input.conversationId ||
      snapshot.restored
    ) {
      return { kind: 'none' }
    }
    if (snapshot.oldFirstId === input.firstMessageId) {
      return { kind: 'waiting', snapshot }
    }
    if (snapshot.generation === undefined) {
      this.active = null
      return { kind: 'dropped', snapshot }
    }
    return {
      kind: 'reconcile',
      snapshot,
      generation: snapshot.generation,
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

  expireRestored(requestId: number, restoredAt: number): void {
    if (
      this.active?.requestId === requestId &&
      this.active.restoredAt === restoredAt
    ) {
      this.active = null
    }
  }
}
