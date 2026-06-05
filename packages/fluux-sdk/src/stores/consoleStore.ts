import { createStore } from 'zustand/vanilla'
import type { XmppPacket } from '../core'
import { generateUUID } from '../utils/uuid'

const MAX_ENTRIES = 2000
const DEFAULT_HEIGHT = 300
const BATCH_INTERVAL_MS = 100

/**
 * Console state interface for the XMPP debug console.
 *
 * Manages the debug console visibility, height, and packet log entries.
 * Captures all incoming and outgoing XMPP stanzas for debugging purposes.
 * Entries are limited to MAX_ENTRIES to prevent memory issues.
 *
 * Incoming packets and events are buffered and flushed to the store in
 * batches (every 100ms) to avoid per-stanza array copies and re-renders
 * during high-throughput phases like room joins.
 *
 * @remarks
 * Most applications should use the `useConsole` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * @example Direct store access (advanced)
 * ```ts
 * import { useConsoleStore } from '@fluux/sdk'
 *
 * // Toggle console visibility
 * useConsoleStore.getState().toggle()
 *
 * // Add a packet entry (typically called by the SDK internals)
 * useConsoleStore.getState().addPacket('outgoing', '<message>...</message>')
 *
 * // Subscribe to new entries
 * useConsoleStore.subscribe(
 *   (state) => state.entries,
 *   (entries) => console.log('New entry:', entries[entries.length - 1])
 * )
 * ```
 *
 * @category Stores
 */
interface ConsoleState {
  isOpen: boolean
  height: number
  entries: XmppPacket[]

  // Actions
  toggle: () => void
  setOpen: (open: boolean) => void
  setHeight: (height: number) => void
  addPacket: (direction: 'incoming' | 'outgoing', xml: string) => void
  addEvent: (message: string, category?: 'connection' | 'error' | 'sm' | 'presence' | 'e2ee') => void
  clearEntries: () => void
  reset: () => void
}

const initialState = {
  isOpen: false,
  height: DEFAULT_HEIGHT,
  entries: [] as XmppPacket[],
}

// Batching buffer — entries accumulate here and are flushed periodically
let pendingEntries: XmppPacket[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (pendingEntries.length === 0) return
    const batch = pendingEntries
    pendingEntries = []
    consoleStore.setState((state) => {
      const merged = [...state.entries, ...batch]
      return { entries: merged.length > MAX_ENTRIES ? merged.slice(-MAX_ENTRIES) : merged }
    })
  }, BATCH_INTERVAL_MS)
}

function enqueue(entry: XmppPacket): void {
  pendingEntries.push(entry)
  scheduleFlush()
}

export const consoleStore = createStore<ConsoleState>((set) => ({
  ...initialState,

  toggle: () => set((state) => ({ isOpen: !state.isOpen })),

  setOpen: (open) => set({ isOpen: open }),

  setHeight: (height) => set({ height }),

  addPacket: (direction, xml) => {
    enqueue({
      id: generateUUID(),
      type: direction,
      content: xml,
      timestamp: new Date(),
    })
  },

  addEvent: (message, category) => {
    enqueue({
      id: generateUUID(),
      type: 'event',
      content: message,
      eventCategory: category,
      timestamp: new Date(),
    })
  },

  clearEntries: () => {
    pendingEntries = []
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    set({ entries: [] })
  },

  reset: () => {
    pendingEntries = []
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    set(initialState)
  },
}))

export type { ConsoleState }
