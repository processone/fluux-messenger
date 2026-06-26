/**
 * useMessageRangeSelection — virtualization-friendly bulk-copy selection.
 *
 * Holds a contiguous "copy range" over the in-memory message array, decoupled from the
 * browser's text selection (which cannot span virtualized/unmounted rows). Owns the
 * imperative entry points:
 *   - window keydown: Cmd/Ctrl+A (select all loaded), Escape (clear), Cmd/Ctrl+C (copy),
 *     gated to when focus is within the list's `.focus-zone` and not in an input/textarea.
 *   - delegated `mousedown` on the scroll container: Shift-click extends the range (and
 *     suppresses native shift text-extend); a plain click clears any active range so native
 *     text selection resumes.
 * Copy reconstructs text from the array (never the DOM) via collectRangeMeta + buildCopyText.
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { buildCopyText, type CopyMessageMeta } from '@/utils/buildCopyText'
import {
  type CopyRange,
  rangeIds,
  selectAllRange,
  pruneRange,
  selectionReducer,
  collectRangeMeta,
} from '@/utils/messageRangeSelection'
import { useToastStore } from '@/stores/toastStore'

interface Options<T extends { id: string }> {
  containerRef: RefObject<HTMLElement | null>
  messages: T[]
  formatForCopy?: (m: T) => CopyMessageMeta
  conversationId: string
  enabled?: boolean
}

export function useMessageRangeSelection<T extends { id: string }>({
  containerRef,
  messages,
  formatForCopy,
  conversationId,
  enabled = true,
}: Options<T>) {
  const { t } = useTranslation()
  const [range, setRange] = useState<CopyRange | null>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)

  const orderedIds = useMemo(() => messages.map((m) => m.id), [messages])

  // Latest-refs so the imperative listeners read current data without re-binding per message.
  const rangeRef = useRef(range)
  rangeRef.current = range
  const orderedIdsRef = useRef(orderedIds)
  orderedIdsRef.current = orderedIds
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const formatRef = useRef(formatForCopy)
  formatRef.current = formatForCopy
  const tRef = useRef(t)
  tRef.current = t

  const copySelectedIds = useMemo(
    () => new Set(range ? rangeIds(orderedIds, range) : []),
    [orderedIds, range],
  )

  // Prune when the message set changes (a selected message was retracted/removed).
  useEffect(() => {
    setRange((r) => pruneRange(r, orderedIds))
  }, [orderedIds])

  // Clear when switching conversations/rooms.
  useEffect(() => {
    setRange(null)
  }, [conversationId])

  // Track the container element in state so listeners (re)bind when it mounts.
  useEffect(() => {
    if (containerRef.current !== container) setContainer(containerRef.current)
  }, [containerRef, container])

  const selectAll = () => setRange(selectAllRange(orderedIdsRef.current))
  const clearSelection = () => setRange(null)
  const extendTo = (id: string) =>
    setRange((r) => selectionReducer(r, { type: 'extendTo', id }, orderedIdsRef.current))

  const copySelected = () => {
    const r = rangeRef.current
    const format = formatRef.current
    if (!r || !format) return
    const ids = rangeIds(orderedIdsRef.current, r)
    if (ids.length === 0) return
    const msgs = messagesRef.current
    let text: string | null
    if (ids.length === 1) {
      const only = msgs.find((m) => m.id === ids[0])
      text = only ? format(only).body || null : null
    } else {
      text = buildCopyText(collectRangeMeta(msgs, r, format))
    }
    if (!text) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => useToastStore.getState().addToast('success', tRef.current('chat.selection.copied')))
      .catch(() => {
        /* clipboard unavailable / denied: leave the selection so the user can retry */
      })
  }

  useEffect(() => {
    if (!enabled || !container) return

    const isEditable = (el: Element | null) =>
      !!el &&
      el instanceof HTMLElement &&
      (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')

    const focusWithinList = () => {
      const active = document.activeElement
      const zone = container.closest('.focus-zone')
      return container.contains(active) || (!!zone && zone.contains(active))
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!focusWithinList() || isEditable(document.activeElement)) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        window.getSelection()?.removeAllRanges()
        selectAll()
      } else if (e.key === 'Escape') {
        if (rangeRef.current) {
          e.preventDefault()
          e.stopPropagation()
          clearSelection()
        }
      } else if (mod && (e.key === 'c' || e.key === 'C')) {
        if (rangeRef.current) {
          e.preventDefault()
          copySelected()
        }
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      const rowEl = (e.target as Element)?.closest?.('[data-message-id]') as HTMLElement | null
      const id = rowEl?.getAttribute('data-message-id') || ''
      if (e.shiftKey && id) {
        e.preventDefault() // suppress the browser's shift text-extend
        window.getSelection()?.removeAllRanges()
        extendTo(id)
      } else if (!e.shiftKey && rangeRef.current) {
        clearSelection() // a fresh plain click drops the range; native selection resumes
      }
    }

    window.addEventListener('keydown', onKeyDown)
    container.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('mousedown', onMouseDown)
    }
  }, [enabled, container])

  return {
    copySelectedIds,
    selectionCount: copySelectedIds.size,
    isSelecting: range !== null,
    selectAll,
    extendTo,
    clearSelection,
    copySelected,
  }
}
