/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { render, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useMessageListScroll,
  type UseMessageListScrollResult,
} from './useMessageListScroll'
import { scrollStateManager } from '@/utils/scrollStateManager'

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

interface HarnessHandle {
  api: UseMessageListScrollResult
  scroller: HTMLDivElement
  scrollTopSets: number[]
  getScrollTop: () => number
}

interface HookHarnessProps {
  conversationId: string
  ids: string[]
  firstNewMessageId?: string
  readPointerId?: string
  clearFirstNewMessageId?: () => void
  onLoadAround?: (anchorMessageId: string) => Promise<unknown> | void
  scrollHeight?: number
  clientHeight?: number
  initialScrollTop?: number
  onReady: (handle: HarnessHandle) => void
}

function seedSavedScrollPosition(conversationId: string, scrollTop = 200, readPositionId?: string) {
  scrollStateManager.enterConversation(conversationId, 10)
  scrollStateManager.leaveConversation(conversationId, scrollTop, 1000, 500, undefined, readPositionId)
}

// Seed a saved CONTENT anchor whose scrollHeight differs from the harness scroller (1000) so the
// exact-scrollTop fast-path is skipped and the anchor path runs — mirrors returning to a deeply
// scrolled-back conversation whose tall window was evicted and rehydrated to a short latest slice.
function seedSavedAnchor(conversationId: string, anchorMessageId: string, scrollTop = 200) {
  scrollStateManager.enterConversation(conversationId, 10)
  scrollStateManager.leaveConversation(conversationId, scrollTop, 5000, 500, {
    messageId: anchorMessageId,
    fraction: 1,
  })
}

function HookHarness({
  conversationId,
  ids,
  firstNewMessageId,
  readPointerId,
  clearFirstNewMessageId,
  onLoadAround,
  scrollHeight = 1000,
  clientHeight = 500,
  initialScrollTop = 0,
  onReady,
}: HookHarnessProps) {
  const geometryRef = React.useRef({ scrollHeight, clientHeight })
  geometryRef.current = { scrollHeight, clientHeight }
  const scrollTopRef = React.useRef(initialScrollTop)
  const scrollTopSetsRef = React.useRef<number[]>([])
  const scrollerRef = React.useRef<HTMLDivElement | null>(null)

  const api = useMessageListScroll({
    conversationId,
    messageCount: ids.length,
    firstMessageId: ids[0],
    firstNewMessageId,
    readPointerId,
    clearFirstNewMessageId,
    onLoadAround,
    reactionsSignature: '',
    lastMessageId: ids.at(-1),
  })

  const setScrollContainerRef = api.setScrollContainerRef
  const setScrollerRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node
      if (node) {
        Object.defineProperty(node, 'scrollHeight', {
          get: () => geometryRef.current.scrollHeight,
          configurable: true,
        })
        Object.defineProperty(node, 'clientHeight', {
          get: () => geometryRef.current.clientHeight,
          configurable: true,
        })
        Object.defineProperty(node, 'scrollTop', {
          get: () => scrollTopRef.current,
          set: (value: number) => {
            scrollTopRef.current = value
            scrollTopSetsRef.current.push(value)
          },
          configurable: true,
        })
        Object.defineProperty(node, 'scrollTo', {
          value: (options: ScrollToOptions | number) => {
            const top = typeof options === 'number' ? options : options.top
            if (typeof top === 'number') {
              node.scrollTop = top
            }
          },
          configurable: true,
        })
      }
      setScrollContainerRef(node)
    },
    [setScrollContainerRef],
  )

  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    onReady({
      api,
      scroller,
      scrollTopSets: scrollTopSetsRef.current,
      getScrollTop: () => scrollTopRef.current,
    })
  })

  return (
    <div ref={setScrollerRef} onScroll={api.handleScroll} data-message-list>
      {ids.length > 0 && (
        <div ref={api.contentWrapperRef}>
          {ids.map((id, index) => (
            <div
              key={id}
              ref={(node) => {
                if (!node) return
                Object.defineProperty(node, 'offsetTop', { value: index * 40, configurable: true })
                Object.defineProperty(node, 'offsetHeight', { value: 40, configurable: true })
              }}
              className="message-row"
              data-message-id={id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

describe('useMessageListScroll saved-position restore', () => {
  let realRaf: typeof requestAnimationFrame

  beforeEach(() => {
    scrollStateManager.reset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    realRaf = window.requestAnimationFrame
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }
  })

  afterEach(() => {
    window.requestAnimationFrame = realRaf
    vi.unstubAllGlobals()
  })

  it('keeps a saved room restore pending until rows are mounted', () => {
    seedSavedScrollPosition('room-pending', 200)
    let handle: HarnessHandle | undefined

    const { rerender } = render(
      <HookHarness
        conversationId="room-pending"
        ids={[]}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).not.toContain(1000)
    expect(scrollStateManager.getSavedScrollTop('room-pending')).toBe(200)

    handle?.scrollTopSets.splice(0)
    rerender(
      <HookHarness
        conversationId="room-pending"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(handle?.scrollTopSets).not.toContain(1000)
  })

  it('can restore the same scrolled-up room again without an intervening scroll event', () => {
    seedSavedScrollPosition('room-repeat-hook', 200)
    let handle: HarnessHandle | undefined

    const { rerender } = render(
      <HookHarness
        conversationId="room-repeat-hook"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(scrollStateManager.getSavedScrollTop('room-repeat-hook')).toBe(200)

    handle?.scrollTopSets.splice(0)
    rerender(
      <HookHarness
        conversationId="room-other-hook"
        ids={['other-0', 'other-1']}
        onReady={(next) => { handle = next }}
      />,
    )

    handle?.scrollTopSets.splice(0)
    rerender(
      <HookHarness
        conversationId="room-repeat-hook"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(handle?.scrollTopSets).not.toContain(1000)
  })

  // The unread-marker positioning runs in a requestAnimationFrame loop that intentionally bails
  // if prevConversationRef (set at the END of the conversation-switch effect) doesn't yet match —
  // so it must run AFTER the effect, like a real async rAF. The shared beforeEach uses a synchronous
  // rAF (fine for the restore path, which writes scrollTop directly in the effect); these
  // marker-positioning tests install a deferred queue and flush it after render instead.
  const installDeferredRaf = () => {
    const queue: FrameRequestCallback[] = []
    window.requestAnimationFrame = (cb: FrameRequestCallback) => { queue.push(cb); return queue.length }
    const flush = (max = 400) => {
      act(() => {
        let n = 0
        while (queue.length && n++ < max) {
          const cb = queue.shift()!
          cb(0)
        }
      })
    }
    return flush
  }

  const markerTarget = 400 - 500 / 3 // msg-10 offsetTop(400) minus clientHeight/3
  const manyIds = () => Array.from({ length: 20 }, (_, i) => `msg-${i}`)

  // NOTE: the unread-marker scroll branch is intentionally NOT gated on first-open at the scroll
  // layer — that could not tell a stale/synced marker from a genuine "new message while away" marker
  // and broke the latter on re-entry (scroll-invariants e2e). The "synced marker only on first open"
  // behavior is enforced at the SDK source (XEP-0490 entry fold), see chatStore/roomStore tests.

  it('scrolls to the unread marker on the first open of a conversation this session', () => {
    const flush = installDeferredRaf()
    let handle: HarnessHandle | undefined

    render(
      <HookHarness
        conversationId="first-open-marker"
        ids={manyIds()}
        firstNewMessageId="msg-10"
        onReady={(next) => { handle = next }}
      />,
    )
    flush()

    expect(handle?.scrollTopSets.some((v) => Math.abs(v - markerTarget) < 1)).toBe(true)
  })

  it('restores the saved position (not the marker) when re-opening a scrolled-up conversation', () => {
    seedSavedScrollPosition('reopen-saved', 200)
    const flush = installDeferredRaf()
    let handle: HarnessHandle | undefined

    render(
      <HookHarness
        conversationId="reopen-saved"
        ids={manyIds()}
        firstNewMessageId="msg-10"
        onReady={(next) => { handle = next }}
      />,
    )
    flush()

    expect(handle?.scrollTopSets).toContain(200)
    expect(handle?.scrollTopSets.some((v) => Math.abs(v - markerTarget) < 1)).toBe(false)
  })

  it('discards a saved position when a synced read pointer already reached the downloaded live edge', () => {
    seedSavedScrollPosition('synced-live-edge', 200, 'msg-5')
    let handle: HarnessHandle | undefined

    render(
      <HookHarness
        conversationId="synced-live-edge"
        ids={manyIds()}
        readPointerId="msg-19"
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).not.toContain(200)
    expect(handle?.getScrollTop()).toBe(1000)
    expect(scrollStateManager.getSavedScrollTop('synced-live-edge')).toBeNull()
  })

  it('keeps a deliberate saved position when its read pointer was already at the live edge', () => {
    seedSavedScrollPosition('same-live-edge', 200, 'msg-19')
    let handle: HarnessHandle | undefined

    render(
      <HookHarness
        conversationId="same-live-edge"
        ids={manyIds()}
        readPointerId="msg-19"
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(scrollStateManager.getSavedScrollTop('same-live-edge')).toBe(200)
  })

  it('settles to the bottom when MAM resolves the synced read pointer after restore', () => {
    seedSavedScrollPosition('late-live-edge', 200, 'msg-5')
    let handle: HarnessHandle | undefined
    const view = render(
      <HookHarness
        conversationId="late-live-edge"
        ids={manyIds()}
        readPointerId="msg-5"
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)

    view.rerender(
      <HookHarness
        conversationId="late-live-edge"
        ids={manyIds()}
        readPointerId="msg-19"
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.getScrollTop()).toBe(1000)
    expect(scrollStateManager.getSavedScrollTop('late-live-edge')).toBeNull()
  })

  it('clears restored scrolled-up state only after explicit bottom intent', () => {
    seedSavedScrollPosition('room-bottom-intent', 200)
    let handle: HarnessHandle | undefined

    render(
      <HookHarness
        conversationId="room-bottom-intent"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onReady={(next) => { handle = next }}
      />,
    )

    expect(handle?.scrollTopSets).toContain(200)
    expect(scrollStateManager.getSavedScrollTop('room-bottom-intent')).toBe(200)

    act(() => {
      handle?.api.scrollToBottom()
    })

    expect(handle?.getScrollTop()).toBe(1000)
    expect(scrollStateManager.getSavedScrollTop('room-bottom-intent')).toBeNull()
  })

  // Regression: returning to a conversation scrolled deep into history. The saved anchor points at
  // an OLD message that the latest-N rehydration didn't load, so restore can't resolve it. It must
  // request the cache slice AROUND the anchor (onLoadAround) rather than fall back to the saved
  // scrollTop on the short list (which landed near the top at the load-more trigger — the bug).
  it('requests the cache slice around a saved anchor that is not in the loaded set', () => {
    seedSavedAnchor('around-missing', 'old-anchor')
    const onLoadAround = vi.fn().mockResolvedValue([])

    render(
      <HookHarness
        conversationId="around-missing"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onLoadAround={onLoadAround}
        onReady={() => {}}
      />,
    )

    expect(onLoadAround).toHaveBeenCalledWith('old-anchor')
  })

  it('does not request a slice when the saved anchor is already in the loaded set', () => {
    seedSavedAnchor('around-present', 'msg-1')
    const onLoadAround = vi.fn().mockResolvedValue([])

    render(
      <HookHarness
        conversationId="around-present"
        ids={['msg-0', 'msg-1', 'msg-2']}
        onLoadAround={onLoadAround}
        onReady={() => {}}
      />,
    )

    expect(onLoadAround).not.toHaveBeenCalled()
  })

  // Regression: after a restore, the view can shift on its own as rows below the fold load media /
  // re-measure. Those non-user scroll events must NOT overwrite the saved position — otherwise the
  // (drifted, older) position is persisted and the next open starts from there, compounding into
  // "goes back in time on every switch". Only a genuine user scroll updates the saved position.
  describe('save gating after restore', () => {
    const scrollAndFire = (handle: HarnessHandle, top: number) => {
      handle.scroller.scrollTop = top
      handle.api.handleScroll({ currentTarget: handle.scroller } as unknown as React.UIEvent<HTMLDivElement>)
    }

    it('does not overwrite the saved position from a non-user (media/measurement) scroll', () => {
      seedSavedScrollPosition('gate-nonuser', 200)
      let handle: HarnessHandle | undefined
      render(
        <HookHarness conversationId="gate-nonuser" ids={['m0', 'm1', 'm2']} onReady={(n) => { handle = n }} />,
      )

      // A spontaneous (non-user) scroll to a different, not-at-bottom position.
      act(() => scrollAndFire(handle!, 320))

      expect(scrollStateManager.getSavedScrollTop('gate-nonuser')).toBe(200)
    })

    it('saves the new position once the user genuinely scrolls (wheel)', () => {
      seedSavedScrollPosition('gate-user', 200)
      let handle: HarnessHandle | undefined
      render(
        <HookHarness conversationId="gate-user" ids={['m0', 'm1', 'm2']} onReady={(n) => { handle = n }} />,
      )

      act(() => {
        handle!.api.handleWheel({ currentTarget: handle!.scroller, deltaY: -10 } as unknown as React.WheelEvent<HTMLDivElement>)
        scrollAndFire(handle!, 320)
      })

      expect(scrollStateManager.getSavedScrollTop('gate-user')).toBe(320)
    })

    // Regression (the compounding "few px on every reload"): the post-restore SETTLE fires MORE THAN
    // ONE height-unchanged scroll event. The first only sets prevScrollHeight; the second then matches
    // it and — no input event, no loop running — looked exactly like a scrollbar drag, opened the save
    // gate, and persisted the drifted position (→ the reading position creeps older on every re-open).
    // A pure settle must not save: two settle events with no wheel/touch/key leave the saved position.
    it('does not save a multi-event settle right after restore (programmatic window)', () => {
      seedSavedScrollPosition('gate-settle', 200)
      let handle: HarnessHandle | undefined
      render(
        <HookHarness conversationId="gate-settle" ids={['m0', 'm1', 'm2']} onReady={(n) => { handle = n }} />,
      )

      act(() => {
        scrollAndFire(handle!, 198)
        scrollAndFire(handle!, 196)
      })

      expect(scrollStateManager.getSavedScrollTop('gate-settle')).toBe(200)
    })
  })
})
