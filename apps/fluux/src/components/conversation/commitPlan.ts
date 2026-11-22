/**
 * The commit plan: which scroll work a React commit owes, and in what order.
 *
 * Before this table, the order of the message-list scroll work was whatever order twenty-two effects
 * happened to be declared in, each with its own dependency list. Now the hook gathers the facts of a
 * commit into one object and asks `planCommit` for the ordered event list; one layout effect and one
 * passive effect run it. This function reads nothing but the two fact objects: no DOM, controller,
 * refs or timers.
 *
 * A fact object holds every value an old effect listed as a dependency, including the identity of
 * the callbacks the hook derives (they change when their own inputs change, exactly as before). An
 * event is planned when any fact in its trigger list differs from the previous commit, or on the
 * first commit. Rules that returned before touching anything (static mode, an unchanged signature,
 * the same conversation) live here, so the handlers only run when they have something to do.
 *
 * Rule table: docs/2026-07-23-scroll-positioning-contract.md, "Commit events".
 */

/** Every value that decides whether scroll work is owed this commit. Functions are compared by identity. */
export interface CommitFacts {
  conversationId: string
  messageCount: number
  firstMessageId: string | undefined
  lastMessageId: string | undefined
  interiorPlacementVersion: number
  windowAtLiveEdge: boolean | undefined
  isLoadingOlder: boolean | undefined
  isLoadingNewer: boolean | undefined
  firstNewMessageId: string | undefined
  readPointerId: string | undefined
  targetMessageId: string | null | undefined
  staticMode: boolean
  lastMessageIsOutgoing: boolean
  hasTypingIndicator: boolean
  rowGrowthSignature: string
  /** Identities of the callbacks the old effects listed as dependencies. */
  callbacks: {
    rebaseArrivalBaseline: unknown
    assumeAtBottom: unknown
    assumeAwayFromBottom: unknown
    assumeEntryPosition: unknown
    cancelMediaBatch: unknown
    resetLiveEdgeRepaintDebt: unknown
    resetPendingInput: unknown
    createLiveEdgeExecutor: unknown
    buildSavedPositionExecutor: unknown
    buildUnreadMarkerExecutor: unknown
    buildExplicitTargetExecutor: unknown
    buildDirectionalHistoryExecutor: unknown
    restartDirectionalRestore: unknown
    applyDirectionalReleaseDecision: unknown
    emergencyLiveEdgeWrite: unknown
    reconcileLiveEdge: unknown
    reconcileMessageTargetAfterResize: unknown
  }
}

export type CommitPhase = 'layout' | 'passive'

/** One owed piece of work. Planned order is run order. */
export type CommitEvent =
  /** Layout: enter a conversation (first mount or a switch) and place the reader. */
  | { kind: 'enter-conversation'; phase: 'layout' }
  /** Layout: a synced read pointer arrived late and may supersede a restored position. */
  | { kind: 'late-synced-read'; phase: 'layout' }
  /** Layout: the unread divider may have been cleared by another device before any input. */
  | { kind: 'settle-divider'; phase: 'layout'; sameConversation: boolean; previousDivider: string | undefined }
  /** Layout: a restored position still waiting for rows is refreshed. */
  | { kind: 'refresh-saved-position'; phase: 'layout' }
  /** Layout: an idle live-edge request is refreshed. */
  | { kind: 'refresh-live-edge'; phase: 'layout' }
  /** Layout: a directional load may have landed, restore the reader's anchor before paint. */
  | { kind: 'restore-directional-window'; phase: 'layout' }
  /** Layout: the bottom row changed, follow it or hold the reader. */
  | { kind: 'arrival'; phase: 'layout' }
  /** Layout: row heights changed with the same conversation, re-pin if the reader was at the edge. */
  | { kind: 'row-growth'; phase: 'layout' }
  /** Layout: the typing indicator appeared or went away. */
  | { kind: 'typing-indicator'; phase: 'layout'; sameConversation: boolean; hadTypingIndicator: boolean }
  /** Layout, every commit: a held message keeps its place and the jump button follows. */
  | { kind: 'refresh-interaction-hold'; phase: 'layout' }
  /** Passive: remember the read position the reader left behind. */
  | { kind: 'remember-read-position'; phase: 'passive' }
  /** Passive, every commit: publish the committed values the browser-side ports read. */
  | { kind: 'publish-committed'; phase: 'passive' }
  /** Passive, first commit: log the mount. */
  | { kind: 'log-mount'; phase: 'passive' }
  /** Passive: a store-requested message target was set, changed, refreshed or cleared. */
  | { kind: 'store-target'; phase: 'passive' }
  /** Passive: the window moved relative to the live edge, release a stale directional anchor. */
  | { kind: 'release-directional-window'; phase: 'passive' }
  /** Passive: an older-history load finished, catch the live edge up. */
  | { kind: 'older-load-finished'; phase: 'passive' }
  /** Passive: the unread marker changed, so a later clear needs a fresh first scroll. */
  | { kind: 'rearm-marker-clear'; phase: 'passive' }

export type CommitEventKind = CommitEvent['kind']

type FactName = Exclude<keyof CommitFacts, 'callbacks'>
type CallbackName = keyof CommitFacts['callbacks']

interface Rule {
  kind: CommitEventKind
  phase: CommitPhase
  /** Plain facts whose change plans the event. */
  facts?: readonly FactName[]
  /** Derived callbacks whose new identity plans the event. */
  callbacks?: readonly CallbackName[]
  /** The event is planned on every commit, whatever changed. */
  always?: true
  /** The event is planned only when this holds (checked after the trigger). */
  when?: (facts: CommitFacts, previous: CommitFacts) => boolean
}

/**
 * The rule table. Row order is run order within a phase. Layout rows run before paint, passive rows
 * after it, and a layout row never waits on a passive one.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'enter-conversation', phase: 'layout',
    facts: [
      'conversationId', 'firstNewMessageId', 'lastMessageId', 'messageCount',
      'readPointerId', 'staticMode', 'targetMessageId', 'windowAtLiveEdge',
    ],
    callbacks: [
      'rebaseArrivalBaseline', 'assumeAtBottom', 'assumeAwayFromBottom', 'assumeEntryPosition',
      'createLiveEdgeExecutor', 'buildSavedPositionExecutor', 'buildUnreadMarkerExecutor',
      'emergencyLiveEdgeWrite', 'cancelMediaBatch', 'resetLiveEdgeRepaintDebt', 'resetPendingInput',
    ],
  },
  {
    kind: 'late-synced-read', phase: 'layout',
    facts: ['conversationId', 'firstNewMessageId', 'lastMessageId', 'readPointerId', 'staticMode'],
    callbacks: ['assumeAtBottom', 'createLiveEdgeExecutor', 'emergencyLiveEdgeWrite'],
  },
  {
    kind: 'settle-divider', phase: 'layout',
    facts: ['conversationId', 'firstNewMessageId', 'staticMode'],
    callbacks: ['assumeAtBottom', 'createLiveEdgeExecutor', 'emergencyLiveEdgeWrite'],
  },
  {
    kind: 'refresh-saved-position', phase: 'layout',
    facts: [
      'conversationId', 'firstMessageId', 'lastMessageId', 'messageCount', 'staticMode',
      'windowAtLiveEdge',
    ],
    callbacks: ['rebaseArrivalBaseline', 'buildSavedPositionExecutor'],
    when: (facts) => !facts.staticMode,
  },
  {
    kind: 'refresh-live-edge', phase: 'layout',
    facts: [
      'conversationId', 'firstMessageId', 'isLoadingNewer', 'lastMessageId', 'messageCount',
      'staticMode', 'windowAtLiveEdge',
    ],
    callbacks: ['createLiveEdgeExecutor'],
    when: (facts) => !facts.staticMode,
  },
  {
    kind: 'restore-directional-window', phase: 'layout',
    facts: ['conversationId', 'firstMessageId', 'interiorPlacementVersion', 'messageCount', 'staticMode'],
    callbacks: ['buildDirectionalHistoryExecutor', 'restartDirectionalRestore'],
    when: (facts) => !facts.staticMode,
  },
  {
    kind: 'arrival', phase: 'layout',
    facts: [
      'conversationId', 'lastMessageId', 'lastMessageIsOutgoing', 'messageCount', 'staticMode',
      'windowAtLiveEdge',
    ],
    callbacks: [
      'rebaseArrivalBaseline', 'assumeAtBottom', 'assumeAwayFromBottom', 'createLiveEdgeExecutor',
      'emergencyLiveEdgeWrite', 'reconcileLiveEdge',
    ],
  },
  {
    kind: 'row-growth', phase: 'layout',
    facts: ['rowGrowthSignature', 'conversationId', 'staticMode'],
    callbacks: ['reconcileMessageTargetAfterResize'],
    // A conversation switch re-baselines and never re-pins; an unchanged signature is an unrelated render.
    when: (facts, previous) =>
      facts.conversationId === previous.conversationId &&
      facts.rowGrowthSignature !== previous.rowGrowthSignature,
  },
  {
    kind: 'typing-indicator', phase: 'layout',
    facts: ['hasTypingIndicator', 'conversationId', 'staticMode'],
    callbacks: ['reconcileLiveEdge'],
  },
  { kind: 'refresh-interaction-hold', phase: 'layout', always: true },

  { kind: 'remember-read-position', phase: 'passive', facts: ['conversationId', 'readPointerId'] },
  { kind: 'publish-committed', phase: 'passive', always: true },
  { kind: 'log-mount', phase: 'passive' },
  {
    kind: 'store-target', phase: 'passive',
    facts: ['targetMessageId', 'messageCount', 'conversationId', 'staticMode'],
    callbacks: ['assumeAwayFromBottom', 'buildExplicitTargetExecutor'],
  },
  {
    kind: 'release-directional-window', phase: 'passive',
    facts: ['conversationId', 'windowAtLiveEdge'],
    callbacks: ['applyDirectionalReleaseDecision'],
  },
  {
    kind: 'older-load-finished', phase: 'passive',
    facts: ['isLoadingOlder', 'staticMode'],
    callbacks: ['reconcileLiveEdge'],
    when: (facts, previous) => Boolean(previous.isLoadingOlder) && !facts.isLoadingOlder && !facts.staticMode,
  },
  {
    kind: 'rearm-marker-clear', phase: 'passive',
    facts: ['firstNewMessageId'],
    when: (facts, previous) => facts.firstNewMessageId !== previous.firstNewMessageId,
  },
]

function changed(rule: Rule, facts: CommitFacts, previous: CommitFacts): boolean {
  for (const name of rule.facts ?? []) {
    if (!Object.is(facts[name], previous[name])) return true
  }
  for (const name of rule.callbacks ?? []) {
    if (!Object.is(facts.callbacks[name], previous.callbacks[name])) return true
  }
  return false
}

function eventFor(rule: Rule, facts: CommitFacts, previous: CommitFacts): CommitEvent {
  const sameConversation = previous.conversationId === facts.conversationId
  if (rule.kind === 'settle-divider') {
    return { kind: rule.kind, phase: 'layout', sameConversation, previousDivider: previous.firstNewMessageId }
  }
  if (rule.kind === 'typing-indicator') {
    return { kind: rule.kind, phase: 'layout', sameConversation, hadTypingIndicator: previous.hasTypingIndicator }
  }
  return { kind: rule.kind, phase: rule.phase } as CommitEvent
}

/**
 * The ordered event list for one commit.
 *
 * `previous` is the facts of the commit before, or null on the first commit. On the first commit
 * every rule plans its event, except the ones that only react to a change (row growth, a finished
 * load, a marker change), where "no previous value" reads as "no change".
 */
export function planCommit(previous: CommitFacts | null, facts: CommitFacts): CommitEvent[] {
  const events: CommitEvent[] = []
  const before = previous ?? facts
  for (const rule of RULES) {
    if (rule.kind === 'log-mount') {
      if (previous === null) events.push(eventFor(rule, facts, before))
      continue
    }
    if (!(rule.always === true || previous === null || changed(rule, facts, previous))) continue
    if (rule.when && !rule.when(facts, before)) continue
    events.push(eventFor(rule, facts, before))
  }
  return events
}

export function layoutEvents(events: readonly CommitEvent[]): CommitEvent[] {
  return events.filter((event) => event.phase === 'layout')
}

export function passiveEvents(events: readonly CommitEvent[]): CommitEvent[] {
  return events.filter((event) => event.phase === 'passive')
}
