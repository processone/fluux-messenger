import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { hasHover } from '@/hooks/useHasHover'
import { findMessageRowElement, readMessageRowId } from './messageRowIdentity'

interface InteractionContext {
  heldMessageId: string | null
  heldRow: HTMLElement | null
  setMenuOpen: (rowId: string, open: boolean, close: () => void, sourceRow?: HTMLElement) => void
}

export const MessageInteractionContext = createContext<InteractionContext | null>(null)

interface InteractionPorts {
  begin: (rowId: string) => boolean
  release: (resume: boolean) => void
}

/** FLM-229: hover caused by moving content is not deliberate interaction. */
export function useMessageInteractionHold({
  scrollRef, conversationId, enabled, begin, release,
}: InteractionPorts & {
  scrollRef: RefObject<HTMLElement | null>
  conversationId: string
  enabled: boolean
}) {
  const ports = useRef({ begin, release })
  ports.current = { begin, release }
  const [heldMessageId, setHeldMessageId] = useState<string | null>(null)
  const held = useRef<{ id: string; row: HTMLElement } | null>(null)
  const pointerRow = useRef<HTMLElement | null>(null)
  const focusRow = useRef<HTMLElement | null>(null)
  const menu = useRef<{ row: HTMLElement; close: () => void } | null>(null)
  const dragging = useRef(false)
  const keyboard = useRef(true)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearLeave = useCallback(() => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
    leaveTimer.current = null
  }, [])

  // Also called by the positioning controller before navigation takes the pixels.
  const cancel = useCallback(() => {
    clearLeave()
    held.current = null
    pointerRow.current = null
    focusRow.current = null
    dragging.current = false
    const closing = menu.current
    menu.current = null
    closing?.close()
    setHeldMessageId(null)
  }, [clearLeave])

  const start = useCallback((row: HTMLElement, refresh = false) => {
    const id = readMessageRowId(row)
    if (!id || !row.querySelector('[data-message-toolbar]') ||
      !scrollRef.current || findMessageRowElement(scrollRef.current, id) !== row) return
    clearLeave()
    if (menu.current && menu.current.row !== row) return
    if (held.current?.row === row) { if (refresh) ports.current.begin(held.current.id); return }
    if (!ports.current.begin(id)) return
    held.current = { id, row }
    setHeldMessageId(id)
  }, [clearLeave, scrollRef])

  const maybeRelease = useCallback(() => {
    const target = held.current
    if (!target || dragging.current || pointerRow.current === target.row ||
      keyboard.current && focusRow.current === target.row || menu.current?.row === target.row) {
      clearLeave()
      return
    }
    if (leaveTimer.current !== null) return
    // The existing toolbar uses the same short bridge across its row boundary.
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null
      const target = held.current
      if (!target || dragging.current || pointerRow.current === target.row ||
        keyboard.current && focusRow.current === target.row || menu.current?.row === target.row) return
      cancel()
      ports.current.release(true)
    }, 100)
  }, [cancel, clearLeave])

  const setMenuOpen = useCallback((id: string, open: boolean, close: () => void, sourceRow?: HTMLElement) => {
    if (!enabled) return
    if (open) {
      if (!hasHover()) return
      const row = sourceRow ?? (scrollRef.current && findMessageRowElement(scrollRef.current, id))
      if (row) start(row, true)
      if (row && held.current?.row === row) menu.current = { row, close }
    } else if (menu.current && (!sourceRow || menu.current.row === sourceRow)) {
      menu.current = null
      maybeRelease()
    }
  }, [enabled, scrollRef, start, maybeRelease])

  useEffect(() => {
    if (!enabled) return
    let point: { x: number; y: number } | null = null
    const rowFor = (target: EventTarget | null) => {
      // Confirmation dialogs are DOM descendants of a row, but are not its toolbar interaction.
      if (target instanceof Element && target.closest('[data-modal]')) return null
      const row = target instanceof Element ? target.closest<HTMLElement>('[data-message-row-id]') : null
      return row && scrollRef.current?.contains(row) ? row : null
    }
    const onMove = (event: MouseEvent) => {
      const moved = point
        ? point.x !== event.clientX || point.y !== event.clientY
        : Boolean(event.movementX || event.movementY)
      point = { x: event.clientX, y: event.clientY }
      const row = rowFor(event.target)
      pointerRow.current = row
      if (moved && hasHover()) {
        keyboard.current = false
        if (row && !dragging.current) start(row)
      }
      maybeRelease()
    }
    const onOut = (event: MouseEvent) => {
      const row = rowFor(event.relatedTarget)
      pointerRow.current = row
      maybeRelease()
    }
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0 || !hasHover()) return
      keyboard.current = false
      const row = rowFor(event.target)
      if (row) {
        pointerRow.current = row
        start(row)
        dragging.current = true
      }
    }
    const onUp = () => { dragging.current = false; maybeRelease() }
    const onKey = () => { keyboard.current = true }
    const onFocus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const row = target?.closest('[data-message-toolbar]') ? rowFor(target) : null
      focusRow.current = row
      if (row && hasHover()) start(row, true)
      maybeRelease()
    }
    const onFocusOut = () => {
      // Escape can restore the trigger in the same event; do not release between them.
      queueMicrotask(() => {
        const active = document.activeElement
        const row = active?.closest('[data-message-toolbar]') ? rowFor(active) : null
        focusRow.current = row
        maybeRelease()
      })
    }
    const onBlur = () => { cancel(); ports.current.release(true); point = null }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('focusout', onFocusOut, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseout', onOut, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('blur', onBlur)
      cancel()
      ports.current.release(false)
    }
  }, [enabled, conversationId, scrollRef, start, cancel, maybeRelease])

  useLayoutEffect(() => {
    const target = held.current
    if (target && (!target.row.isConnected || !scrollRef.current?.contains(target.row) ||
      findMessageRowElement(scrollRef.current, target.id) !== target.row ||
      !target.row.querySelector('[data-message-toolbar]'))) {
      cancel()
      ports.current.release(true)
    }
  })

  useEffect(() => { cancel() }, [conversationId, cancel])

  const context = useMemo(() => ({ heldMessageId, heldRow: held.current?.row ?? null, setMenuOpen }), [heldMessageId, setMenuOpen])
  return { context, cancel }
}
