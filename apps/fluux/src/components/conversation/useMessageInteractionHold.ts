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
// Blink's HandleMouseMoveForMiddleClickAutoscroll changes from latched to held only outside
// kNoMiddleClickAutoscrollRadius (15 CSS px on either axis). A smaller nudge is still latched.
const MIDDLE_PAN_DEAD_ZONE = 15

/** FLM-245 F4: ownership changes update only the old and new row, not every bubble. */
export function useMessageInteractionHeld(ref: RefObject<HTMLElement | null>): boolean {
  const interaction = useContext(MessageInteractionContext)
  const snapshot = useCallback(() => interaction?.isHeld(ref.current) ?? false, [interaction, ref])
  return useSyncExternalStore(interaction?.subscribe ?? noSubscription, snapshot, notHeld)
}

interface InteractionPorts {
  begin: (rowId: string) => boolean
  release: (resume: boolean) => void
  menuChanged?: (open: boolean) => void
}

/** FLM-229: hover caused by moving content is not deliberate interaction. */
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
  const dragging = useRef(false)
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

  const start = useCallback((row: HTMLElement, refresh = false) => {
    const id = readMessageRowId(row)
    if (!id || !row.querySelector('[data-message-toolbar]') ||
      !scrollRef.current || findMessageRowElement(scrollRef.current, id) !== row) return
    clearLeave()
    if (menu.current && menu.current.row !== row) return
    if (held.current?.row === row) {
      if (refresh) ports.current.begin(held.current.id)
      return
    }
    if (!ports.current.begin(id)) return
    held.current = { id, row }
    notify()
  }, [clearLeave, scrollRef, notify])

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
    let point: { x: number; y: number } | null = null
    let suppressPointer = false
    let middlePress: { x: number; y: number } | null = null
    let middlePressMoved = false
    const rowFor = (target: EventTarget | null) => {
      // Confirmation dialogs are DOM descendants of a row, but are not its toolbar interaction.
      if (target instanceof Element && target.closest('[data-modal]')) return null
      const row = target instanceof Element ? target.closest<HTMLElement>('[data-message-row-id]') : null
      return row && scrollRef.current?.contains(row) ? row : null
    }
    const onMove = (event: MouseEvent) => {
      if (middlePress && (event.buttons & 4) !== 0 &&
        (Math.abs(middlePress.x - event.clientX) > MIDDLE_PAN_DEAD_ZONE ||
          Math.abs(middlePress.y - event.clientY) > MIDDLE_PAN_DEAD_ZONE)) middlePressMoved = true
      const moved = point
        ? point.x !== event.clientX || point.y !== event.clientY
        : Boolean(event.movementX || event.movementY)
      point = { x: event.clientX, y: event.clientY }
      const row = rowFor(event.target)
      pointerRow.current = row
      if (moved && hasHover()) {
        keyboard.current = false
        // An ongoing selection/drag must not reacquire after its native scrolling takes over.
        if (row && !dragging.current && event.buttons === 0 && !suppressPointer) start(row)
      }
      maybeRelease()
    }
    const onOut = (event: MouseEvent) => {
      pointerRow.current = rowFor(event.relatedTarget)
      maybeRelease()
    }
    const onDown = (event: MouseEvent) => {
      if (!hasHover()) return
      keyboard.current = false
      if (event.button === 1) {
        // Resume saved following; native autoscroll consumes auxclick and keeps hover blocked.
        suppressPointer = true
        middlePress = { x: event.clientX, y: event.clientY }
        middlePressMoved = false
        cancel()
        ports.current.release(true)
        return
      }
      if (event.button !== 0) return
      suppressPointer = false
      const row = rowFor(event.target)
      if (row) {
        pointerRow.current = row
        start(row)
        dragging.current = true
      }
    }
    const onUp = (event: MouseEvent) => {
      dragging.current = false
      // Autoscroll can consume its stopping mousedown but still deliver mouseup.
      if (event.button !== 1 || middlePress === null || middlePressMoved ||
        !('onauxclick' in document.documentElement)) suppressPointer = false
      middlePress = null
      middlePressMoved = false
      maybeRelease()
    }
    const onAuxClick = (event: MouseEvent) => {
      if (event.button === 1) { suppressPointer = false; middlePress = null; middlePressMoved = false }
    }
    const onDragFinish = (event: DragEvent) => {
      dragging.current = false
      suppressPointer = false
      middlePress = null
      middlePressMoved = false
      pointerRow.current = rowFor(document.elementFromPoint?.(event.clientX, event.clientY) ??
        (event.type === 'drop' ? event.target : null))
      maybeRelease()
    }
    const onKey = () => { keyboard.current = true; suppressPointer = false; middlePress = null; middlePressMoved = false }
    const onFocus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const row = target?.closest('[data-message-toolbar]') ? rowFor(target) : null
      focusRow.current = row
      if (row && keyboard.current && hasHover()) start(row, true)
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
      dragging.current = false
      cancel()
      ports.current.release(true)
      point = null
      suppressPointer = false
      middlePress = null
      middlePressMoved = false
    }
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mouseup', onUp, true)
    document.addEventListener('auxclick', onAuxClick, true)
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
      document.removeEventListener('auxclick', onAuxClick, true)
      document.removeEventListener('dragend', onDragFinish, true)
      document.removeEventListener('drop', onDragFinish, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('keyup', onKey, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('input', onInput, true)
      window.removeEventListener('blur', onBlur)
      dragging.current = false
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
