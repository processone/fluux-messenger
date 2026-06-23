/**
 * THROWAWAY spike harness (Task 5 of the message-view-virtualization plan).
 * Exercises the committed MessageVirtualizer interface + @tanstack adapter + alignment
 * module against the cases that killed react-virtuoso: prepend-anchor, jump-to-unmounted,
 * stick-to-bottom coexistence, variable height. Drive it via window.__spike from the
 * preview. Removed once the decision gate is recorded.
 */
import { useRef, useState, useCallback, useLayoutEffect, useEffect } from 'react'
import { useTanstackMessageVirtualizer } from '../components/conversation/tanstackMessageVirtualizer'
import { markerScrollTop, prependAnchorScrollTop } from '../components/conversation/messageScrollAlignment'
import type { MessageListItem } from '../components/conversation/messageVirtualizer'

interface SpikeMsg { id: string; text: string; tall: boolean }
interface PrependResult { anchorId: string; savedTop: number; restoredTop: number | null; delta: number | null }
interface JumpResult { id: string; viewportTop: number | null; clientHeight: number }

interface SpikeApi {
  prependOlder: (anchorId: string, count?: number) => void
  jumpTo: (id: string) => void
  toggleTall: (id: string) => void
  appendNew: () => void
  setScrollTop: (t: number) => void
  scrollToBottom: () => void
  getState: () => Record<string, number> | null
  rowViewportTop: (id: string) => number | null
  lastPrepend: () => PrependResult | null
  lastJump: () => JumpResult | null
}

declare global {
  interface Window { __spike?: SpikeApi }
}

/** Deterministic varied heights (44..100) so estimateSize (64) diverges from reality. */
function rowHeight(id: string, tall: boolean): number {
  if (tall) return 220
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % 5
  return 44 + h * 14
}

let olderCounter = 0
function makeMessages(n: number): SpikeMsg[] {
  return Array.from({ length: n }, (_, i) => ({ id: `msg-${i}`, text: `Message ${i}`, tall: false }))
}

/** Set scrollTop and fire a scroll event. Real browsers fire 'scroll' on a programmatic
 *  scrollTop write (so @tanstack's offset observer tracks it); the headless preview does
 *  not, so we dispatch it explicitly. Harmless on real browsers. */
function applyScroll(s: HTMLElement, top: number): void {
  s.scrollTop = top
  s.dispatchEvent(new Event('scroll'))
}

export function VirtualizationSpike() {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [messages, setMessages] = useState<SpikeMsg[]>(() => makeMessages(1000))

  const items: MessageListItem<SpikeMsg>[] = messages.map((m) => ({
    kind: 'message', key: m.id, message: m, showAvatar: true, isFirstNew: false,
  }))
  const indexById = new Map(messages.map((m, i) => [m.id, i]))
  const v = useTanstackMessageVirtualizer({ items, indexById, scrollRef })

  const savedAnchorRef = useRef<{ id: string; offset: number } | null>(null)
  const prependResultRef = useRef<PrependResult | null>(null)
  const jumpResultRef = useRef<JumpResult | null>(null)
  const atBottomRef = useRef(true)
  const prevLenRef = useRef(messages.length)

  const rowViewportTop = useCallback((id: string): number | null => {
    const s = scrollRef.current
    if (!s) return null
    const el = s.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
    if (!el) return null
    return Math.round(el.getBoundingClientRect().top - s.getBoundingClientRect().top)
  }, [])

  const prependOlder = useCallback((anchorId: string, count = 100) => {
    const top = rowViewportTop(anchorId)
    if (top == null) return
    savedAnchorRef.current = { id: anchorId, offset: top }
    prependResultRef.current = { anchorId, savedTop: top, restoredTop: null, delta: null }
    setMessages((prev) => {
      const older: SpikeMsg[] = []
      for (let i = 0; i < count; i++) { olderCounter += 1; older.push({ id: `old-${olderCounter}`, text: `Older ${olderCounter}`, tall: false }) }
      return [...older, ...prev]
    })
  }, [rowViewportTop])

  const jumpTo = useCallback((id: string) => {
    void v.ensureMessageMounted(id).then(() => {
      const s = scrollRef.current
      if (!s) return
      const offset = v.getOffsetForMessageId(id)
      if (offset != null) applyScroll(s, markerScrollTop(offset, s.clientHeight))
      requestAnimationFrame(() => {
        const s2 = scrollRef.current
        if (!s2) return
        const offset2 = v.getOffsetForMessageId(id)
        if (offset2 != null) applyScroll(s2, markerScrollTop(offset2, s2.clientHeight))
        jumpResultRef.current = { id, viewportTop: rowViewportTop(id), clientHeight: s2.clientHeight }
      })
    })
  }, [v, rowViewportTop])

  const toggleTall = useCallback((id: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, tall: !m.tall } : m)))
  }, [])

  const appendNew = useCallback(() => {
    setMessages((prev) => [...prev, { id: `new-${prev.length}`, text: `New ${prev.length}`, tall: false }])
  }, [])

  // Prepend restore (2-step) + stick-to-bottom on append.
  useLayoutEffect(() => {
    const s = scrollRef.current
    const grew = messages.length > prevLenRef.current
    prevLenRef.current = messages.length
    if (!s) return
    const saved = savedAnchorRef.current
    if (saved) {
      const newOffset = v.getOffsetForMessageId(saved.id)
      if (newOffset != null) applyScroll(s, prependAnchorScrollTop(newOffset, saved.offset))
      requestAnimationFrame(() => {
        const s2 = scrollRef.current
        if (!s2) return
        const n2 = v.getOffsetForMessageId(saved.id)
        if (n2 != null) applyScroll(s2, prependAnchorScrollTop(n2, saved.offset))
        requestAnimationFrame(() => {
          const restoredTop = rowViewportTop(saved.id)
          if (prependResultRef.current) {
            prependResultRef.current.restoredTop = restoredTop
            prependResultRef.current.delta = restoredTop == null ? null : restoredTop - saved.offset
          }
        })
      })
      savedAnchorRef.current = null
      return
    }
    if (grew && atBottomRef.current) applyScroll(s, s.scrollHeight)
  }, [messages.length, v, rowViewportTop])

  useEffect(() => {
    window.__spike = {
      prependOlder, jumpTo, toggleTall, appendNew,
      setScrollTop: (t) => { if (scrollRef.current) applyScroll(scrollRef.current, t) },
      scrollToBottom: () => { if (scrollRef.current) applyScroll(scrollRef.current, scrollRef.current.scrollHeight) },
      getState: () => {
        const s = scrollRef.current
        if (!s) return null
        return {
          scrollTop: Math.round(s.scrollTop), scrollHeight: Math.round(s.scrollHeight),
          clientHeight: s.clientHeight, totalSize: Math.round(v.getTotalSize()),
          mounted: s.querySelectorAll('[data-message-id]').length, count: messages.length,
        }
      },
      rowViewportTop,
      lastPrepend: () => prependResultRef.current,
      lastJump: () => jumpResultRef.current,
    }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>
      <div style={{ padding: 8, borderBottom: '1px solid #ccc', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => prependOlder('msg-200')}>prepend 100 @msg-200</button>
        <button onClick={() => jumpTo('msg-5')}>jump msg-5</button>
        <button onClick={() => jumpTo('msg-500')}>jump msg-500</button>
        <button onClick={() => toggleTall('msg-300')}>toggle tall msg-300</button>
        <button onClick={appendNew}>append</button>
        <span>{messages.length} msgs</span>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const s = e.currentTarget
          atBottomRef.current = s.scrollHeight - s.scrollTop - s.clientHeight < 50
        }}
        style={{ flex: 1, overflowY: 'auto', position: 'relative' }}
      >
        <div style={{ height: v.getTotalSize(), position: 'relative', width: '100%' }}>
          {v.getVirtualItems().map((it) => {
            const m = messages[it.index]
            if (!m) return null
            return (
              <div
                key={it.key}
                data-message-id={m.id}
                data-index={it.index}
                ref={v.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${it.start}px)` }}
              >
                <div style={{ minHeight: rowHeight(m.id, m.tall), boxSizing: 'border-box', borderBottom: '1px solid #eee', padding: '4px 12px', background: m.tall ? '#fff3cd' : '#fff' }}>
                  {m.text}{m.tall ? ' — TALL' : ''}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
