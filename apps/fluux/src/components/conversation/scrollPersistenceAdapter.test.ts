import { describe, expect, it, vi } from 'vitest'
import {
  ScrollPersistenceAdapter,
  type ScrollEntryAction,
  type ScrollPersistenceStore,
} from './scrollPersistenceAdapter'
import type { ViewportSessionSnapshot } from './viewportSession'

function createStore(overrides: Partial<ScrollPersistenceStore> = {}) {
  const store: ScrollPersistenceStore = {
    isInitialized: vi.fn(() => false),
    enterConversation: vi.fn((): ScrollEntryAction => 'scroll-to-bottom'),
    getSavedScrollTop: vi.fn(() => null),
    getSavedAnchor: vi.fn(() => null),
    getSavedReadPositionId: vi.fn(() => undefined),
    saveScrollPosition: vi.fn(),
    leaveConversation: vi.fn(),
    markAsLeft: vi.fn(),
    clearSavedScrollState: vi.fn(),
    ...overrides,
  }
  return store
}

function snapshot(
  conversationId: string,
  options: {
    hasGenuineInput?: boolean
    top?: number
  } = {},
): ViewportSessionSnapshot {
  return {
    conversationId,
    geometry: {
      top: options.top ?? 320,
      height: 2_000,
      client: 500,
    },
    bottomAnchor: { messageId: 'message-12', fraction: 0.75 },
    measuredAtLiveEdge: false,
    hasGenuineInput: options.hasGenuineInput ?? true,
    previousScrollHeight: 2_000,
    lastProgrammaticScrollAt: 0,
    lastUserIntentAt: 1_000,
    travelledAwayFromTop: false,
    travelledAwayFromBottom: false,
  }
}

describe('ScrollPersistenceAdapter', () => {
  it('captures first-open status before entry and returns one entry snapshot', () => {
    const callOrder: string[] = []
    const store = createStore({
      isInitialized: vi.fn(() => {
        callOrder.push('is-initialized')
        return false
      }),
      enterConversation: vi.fn((): ScrollEntryAction => {
        callOrder.push('enter')
        return 'restore-position'
      }),
      getSavedScrollTop: vi.fn(() => 240),
      getSavedAnchor: vi.fn(() => ({
        messageId: 'message-9',
        fraction: 0.5,
      })),
      getSavedReadPositionId: vi.fn(() => 'message-8'),
    })

    const entry = new ScrollPersistenceAdapter(store).enterConversation(
      'room-a',
      42,
    )

    expect(callOrder).toEqual(['is-initialized', 'enter'])
    expect(entry).toEqual({
      firstOpenThisSession: true,
      action: 'restore-position',
      savedOffsetPx: 240,
      savedAnchor: { messageId: 'message-9', fraction: 0.5 },
      savedReadPositionId: 'message-8',
    })
  })

  it('saves only genuine, current, non-controller viewport evidence after the throttle', () => {
    const store = createStore()
    const adapter = new ScrollPersistenceAdapter(store, 100)

    expect(adapter.persistViewport({
      conversationId: 'room-a',
      snapshot: snapshot('room-a', { hasGenuineInput: false }),
      readPositionId: 'message-8',
      controllerOwnsPixels: false,
      now: 101,
    })).toBe(false)
    expect(adapter.persistViewport({
      conversationId: 'room-a',
      snapshot: snapshot('room-a'),
      readPositionId: 'message-8',
      controllerOwnsPixels: true,
      now: 101,
    })).toBe(false)
    expect(adapter.persistViewport({
      conversationId: 'room-a',
      snapshot: snapshot('room-b'),
      readPositionId: 'message-8',
      controllerOwnsPixels: false,
      now: 101,
    })).toBe(false)

    expect(adapter.persistViewport({
      conversationId: 'room-a',
      snapshot: snapshot('room-a'),
      readPositionId: 'message-8',
      controllerOwnsPixels: false,
      now: 100,
    })).toBe(false)
    expect(adapter.persistViewport({
      conversationId: 'room-a',
      snapshot: snapshot('room-a'),
      readPositionId: 'message-8',
      controllerOwnsPixels: false,
      now: 101,
    })).toBe(true)
    expect(adapter.persistViewport({
      conversationId: 'room-a',
      snapshot: snapshot('room-a', { top: 360 }),
      readPositionId: 'message-8',
      controllerOwnsPixels: false,
      now: 201,
    })).toBe(false)
    expect(adapter.persistViewport({
      conversationId: 'room-a',
      snapshot: snapshot('room-a', { top: 380 }),
      readPositionId: 'message-8',
      controllerOwnsPixels: false,
      now: 202,
    })).toBe(true)

    expect(store.saveScrollPosition).toHaveBeenNthCalledWith(
      1,
      'room-a',
      320,
      2_000,
      500,
      { messageId: 'message-12', fraction: 0.75 },
      'message-8',
    )
    expect(store.saveScrollPosition).toHaveBeenNthCalledWith(
      2,
      'room-a',
      380,
      2_000,
      500,
      { messageId: 'message-12', fraction: 0.75 },
      'message-8',
    )
  })

  it('saves an eligible outgoing snapshot and otherwise only marks the room left', () => {
    const store = createStore()
    const adapter = new ScrollPersistenceAdapter(store)

    expect(
      adapter.leaveConversation(
        'room-a',
        snapshot('room-a'),
        'message-8',
      ),
    ).toBe('saved')
    expect(store.leaveConversation).toHaveBeenCalledWith(
      'room-a',
      320,
      2_000,
      500,
      { messageId: 'message-12', fraction: 0.75 },
      'message-8',
    )

    expect(
      adapter.leaveConversation(
        'room-b',
        snapshot('room-b', { hasGenuineInput: false }),
        'message-20',
      ),
    ).toBe('marked-left')
    expect(
      adapter.leaveConversation(
        'room-c',
        snapshot('stale-room'),
        'message-30',
      ),
    ).toBe('marked-left')
    expect(store.markAsLeft).toHaveBeenNthCalledWith(1, 'room-b')
    expect(store.markAsLeft).toHaveBeenNthCalledWith(2, 'room-c')
    expect(store.leaveConversation).toHaveBeenCalledTimes(1)
  })

  it('delegates explicit saved-position clearing', () => {
    const store = createStore()
    const adapter = new ScrollPersistenceAdapter(store)

    adapter.clearSavedPosition('room-a')

    expect(store.clearSavedScrollState).toHaveBeenCalledWith('room-a')
  })
})
