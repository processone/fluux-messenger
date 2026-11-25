import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { hasHover } from '@/hooks/useHasHover'
import { findMessageRowElement, readMessageRowId } from './messageRowIdentity'

interface InteractionContext {
  readonly heldMessageId: string | null
  readonly heldRow: HTMLElement | null
  subscribe: (listener: () => void) => () => void
  isHeld: (element: HTMLElement | null) => boolean
  setMenuOpen: (rowId: string, open: boolean, close: () => void, sourceRow?: HTMLElement) => void
}

export const MessageInteractionContext = createContext<InteractionContext | null>(null)
const noSubscription = () => () => {}
const notHeld = () => false

/** FLM-245 F4: ownership changes update only the old and new row, not every bubble. */
export function useMessageInteractionHeld(ref: RefObject<HTMLElement | null>): boolean {
  const interaction = useContext(MessageInteractionContext)
  const snapshot = useCallback(() => interaction?.isHeld(ref.current) ?? false, [interaction, ref])
  return useSyncExternalStore(interaction?.subscribe ?? noSubscription, snapshot, notHeld)
}

function selectionTouches(row: HTMLElement): boolean {
  const selection = document.getSelection()
  return !!selection && !selection.isCollapsed &&
    (row.contains(selection.anchorNode) || row.contains(selection.focusNode))
}

interface InteractionPorts {
  begin: (rowId: string, control?: HTMLElement) => boolean
  release: (resume: boolean) => void
  menuChanged?: (open: boolean) => void
}

/** Passive hover never acquires a positioning hold. */
export function useMessageInteractionHold({
  scrollRef, conversationId, enabled, begin, release, menuChanged,
}: InteractionPorts & {
  scrollRef: RefObject<HTMLElement | null>
  conversationId: string
  enabled: boolean
}) {
  const ports = useRef({ begin, release, menuChanged })
  ports.current = { begin, release, menuChanged }
  const [heldMessageId, setHeldMessageId] = useState<string | null>(null)
  const held = useRef<{ id: string; row: HTMLElement } | null>(null)
  const listeners = useRef(new Set<() => void>())
  const pointerRow = useRef<HTMLElement | null>(null)
  const focusRow = useRef<HTMLElement | null>(null)
  const menu = useRef<{ row: HTMLElement; close: () => void } | null>(null)
  const pressing = useRef(false)
  const nativeDragging = useRef(false)
  const keyboard = useRef(true)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notify = useCallback(() => {
    setHeldMessageId(held.current?.id ?? null)
    for (const listener of [...listeners.current]) listener()
  }, [])
  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener)
    return () => { listeners.current.delete(listener) }
  }, [])
  const isHeld = useCallback((element: HTMLElement | null) =>
    element !== null && held.current?.row.contains(element) === true, [])
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
    // Hold cancellation is not a physical mouseup; a selection drag can still be running.
    const closing = menu.current
    menu.current = null
    closing?.close()
    if (closing) ports.current.menuChanged?.(false)
    notify()
  }, [clearLeave, notify])

  const start = useCallback((row: HTMLElement, refresh = false, control?: HTMLElement) => {
    const id = readMessageRowId(row)
    if (!id || !row.querySelector('[data-message-toolbar]') ||
      !scrollRef.current || findMessageRowElement(scrollRef.current, id) !== row) return
    clearLeave()
    if (menu.current && menu.current.row !== row) return
    if (held.current?.row === row) {
      if (refresh) ports.current.begin(held.current.id, control)
      return
    }
    if (!ports.current.begin(id, control)) return
    held.current = { id, row }
    notify()
  }, [clearLeave, scrollRef, notify])

  const retainsHold = useCallback((row: HTMLElement) =>
    nativeDragging.current || pressing.current && selectionTouches(row) || pointerRow.current === row ||
    keyboard.current && focusRow.current === row || menu.current?.row === row, [])

  const maybeRelease = useCallback(() => {
    const target = held.current
    if (!target || retainsHold(target.row)) {
      clearLeave()
      return
    }
    if (leaveTimer.current !== null) return
    // The existing toolbar uses the same short bridge across its row boundary.
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null
      const target = held.current
      if (!target || retainsHold(target.row)) return
      cancel()
      ports.current.release(true)
    }, 100)
  }, [cancel, clearLeave, retainsHold])

  const setMenuOpen = useCallback((id: string, open: boolean, close: () => void, sourceRow?: HTMLElement) => {
    if (!enabled) return
    if (open) {
      if (!hasHover()) return
      const row = sourceRow ?? (scrollRef.current && findMessageRowElement(scrollRef.current, id))
      if (row) start(row, true)
      if (row && held.current?.row === row) {
        menu.current = { row, close }
        ports.current.menuChanged?.(true)
      }
    } else if (menu.current && (!sourceRow || menu.current.row === sourceRow)) {
      menu.current = null
      ports.current.menuChanged?.(false)
      maybeRelease()
    }
  }, [enabled, scrollRef, start, maybeRelease])

  useEffect(() => {
    if (!enabled) return
    const rowFor = (target: EventTarget | null) => {
      // Confirmation dialogs are DOM descendants of a row, but are not its toolbar interaction.
      if (target instanceof Element && target.closest('[data-modal]')) return null
      const row = target instanceof Element ? target.closest<HTMLElement>('[data-message-row-id]') : null
      return row && scrollRef.current?.contains(row) ? row : null
    }
    const onMove = (event: MouseEvent) => {
      const row = rowFor(event.target)
      if (pressing.current) pointerRow.current = held.current?.row === row ? row : null
      else if (pointerRow.current !== row) pointerRow.current = null
      maybeRelease()
    }
    const onOut = (event: MouseEvent) => {
      if (rowFor(event.relatedTarget) !== pointerRow.current) pointerRow.current = null
      maybeRelease()
    }
    const onDown = (event: MouseEvent) => {
      if (!hasHover()) return
      keyboard.current = false
      nativeDragging.current = false
      if (event.button === 1) {
        cancel()
        ports.current.release(true)
        return
      }
      if (event.button !== 0) return
      const row = rowFor(event.target)
      if (row) {
        pointerRow.current = row
        const control = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-message-toolbar] button') ?? undefined : undefined
        start(row, false, control)
        pressing.current = true
      }
    }
    const onUp = () => {
      pressing.current = false
      nativeDragging.current = false
      const row = held.current?.row
      if (!row || !selectionTouches(row)) pointerRow.current = null
      maybeRelease()
    }
    const onSelectionChange = () => {
      if (!pressing.current && document.getSelection()?.isCollapsed) {
        pointerRow.current = null
      }
      maybeRelease()
    }
    const onDragStart = (event: DragEvent) => {
      nativeDragging.current = !!held.current && rowFor(event.target) === held.current.row
      maybeRelease()
    }
    const onDragFinish = () => {
      pressing.current = false
      nativeDragging.current = false
      pointerRow.current = null
      maybeRelease()
    }
    const onKey = () => {
      keyboard.current = true
      // Pointer cancellation can leave the opener focused without another focusin event.
      const active = document.activeElement
      focusRow.current = active?.closest('[data-message-toolbar]') ? rowFor(active) : null
      maybeRelease()
    }
    const onFocus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const row = target?.closest('[data-message-toolbar]') ? rowFor(target) : null
      focusRow.current = row
      if (row && keyboard.current && hasHover()) start(row, true, target instanceof HTMLElement ? target : undefined)
      maybeRelease()
    }
    const onFocusOut = () => {
      // Escape can restore the trigger in the same event; do not release between them.
      queueMicrotask(() => {
        const active = document.activeElement
        focusRow.current = active?.closest('[data-message-toolbar]') ? rowFor(active) : null
        maybeRelease()
      })
    }
    const onInput = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.message-input') && !target.closest('[data-modal]') &&
        held.current !== null && !menu.current) {
        cancel()
        ports.current.release(true)
      }
    }
    const onBlur = () => {
      pressing.current = false
      nativeDragging.current = false
      cancel()
      ports.current.release(true)
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('dragstart', onDragStart, true)
    document.addEventListener('dragend', onDragFinish, true)
    document.addEventListener('drop', onDragFinish, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('keyup', onKey, true)
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('input', onInput, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseout', onOut, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mouseup', onUp, true)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('dragstart', onDragStart, true)
      document.removeEventListener('dragend', onDragFinish, true)
      document.removeEventListener('drop', onDragFinish, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('keyup', onKey, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('input', onInput, true)
      window.removeEventListener('blur', onBlur)
      pressing.current = false
      nativeDragging.current = false
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

  const context = useMemo(() => ({
    get heldMessageId() { return held.current?.id ?? null },
    get heldRow() { return held.current?.row ?? null },
    subscribe, isHeld, setMenuOpen,
  }), [subscribe, isHeld, setMenuOpen])
  return { context, cancel, heldMessageId }
}
