import {
  useCallback,
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { useRestoreFocus } from '@/hooks/useRestoreFocus'
import { useModalTransition } from '@/hooks/useModalTransition'
import { useFocusTrap } from '@/hooks/useFocusTrap'

/** A panel keyboard handler that also receives the transition-aware `close`. */
type PanelKeyDown = (
  e: React.KeyboardEvent<HTMLDivElement>,
  api: { close: () => void },
) => void

/** Children may be a plain node or a render function receiving `close` (the
 *  transition-aware dismiss), for headers/buttons that need to animate out. */
type OverlayChildren = ReactNode | ((api: { close: () => void }) => ReactNode)

interface ModalOverlayProps {
  /** Dismiss the modal. Backdrop click and Escape route through the exit
   *  transition, then invoke this. */
  onClose: () => void
  /** Vertical placement: 'center' (default) or 'top' (drops in from ~15vh,
   *  used by the command palette). */
  align?: 'center' | 'top'
  /** Tailwind width class for the panel, e.g. 'max-w-sm' (default). */
  width?: string
  /** Extra classes on the glass panel (max-height, flex layout, overflow…). */
  panelClassName?: string
  /** Override the panel enter animation (e.g. the command palette's drop). */
  panelInClass?: string
  /** Focus target restored when the OS window refocuses; defaults to the panel.
   *  See useRestoreFocus for the rationale. */
  focusRef?: RefObject<HTMLElement | null>
  /** Where focus lands when the modal opens (ignored when `focusRef` is set):
   *  - `'auto'` (default): the first focusable child, so form modals focus their
   *    input. Read-only modals whose first focusable is a content control (a
   *    link, a Show more toggle) would draw an unsolicited focus ring here.
   *  - `'panel'`: the panel container itself, so no control is ringed on open.
   *    Tab still moves into the content. Use for display-only modals. */
  initialFocus?: 'auto' | 'panel'
  /** Extra attributes for the panel element (role, aria-modal, …). onKeyDown is
   *  owned by `onPanelKeyDown` — pass that instead. */
  panelProps?: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'onKeyDown' | 'ref'>
  /** Panel-level key handler. Receives the transition-aware `close` so a caller
   *  that owns Escape (and must stopPropagation it) can dismiss with animation.
   *  Pair with `closeOnEscape={false}` to avoid a double handler. */
  onPanelKeyDown?: PanelKeyDown
  /** Document-level Escape-to-close (default true). Set false when the caller
   *  handles Escape itself via `onPanelKeyDown`. */
  closeOnEscape?: boolean
  /** Whether backdrop-click and Escape may dismiss the modal (default true).
   *  Pass `false` while a blocking operation runs (e.g. a key deletion in
   *  flight) so the user can't dismiss mid-flow. */
  dismissable?: boolean
  children: OverlayChildren
}

const ALIGN_CLASS = {
  center: 'items-center',
  top: 'items-start pt-[15vh]',
} as const

/**
 * The single source of truth for the app's frosted-glass modal chrome:
 *
 * - the `.modal-scrim` backdrop (frost + scrim), rendered as a SIBLING layer so
 *   the panel escapes its backdrop root,
 * - the click-to-dismiss layer,
 * - the `.fluux-glass` panel (translucent surface + blur + overlay shadow +
 *   hairline border),
 *
 * plus the shared enter/exit transition, focus restoration across OS window
 * refocus, and Escape-to-close. EVERY modal must render through this component
 * so the glass treatment can never drift per-call-site again — `modalGlass.test`
 * asserts the `.modal-scrim`/`.fluux-glass` literals live nowhere else.
 *
 * Compose the modal's header/body/footer as children. {@link ModalShell} layers
 * the standard titled header (with a close button) on top of this; bespoke
 * dialogs (verify-peer, key-picker, …) pass their own content directly.
 */
export function ModalOverlay({
  onClose,
  align = 'center',
  width = 'max-w-sm',
  panelClassName,
  panelInClass,
  focusRef,
  initialFocus = 'auto',
  panelProps,
  onPanelKeyDown,
  closeOnEscape = true,
  dismissable = true,
  children,
}: ModalOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const { panelClass, scrimClass, requestClose } = useModalTransition(
    panelInClass ? { panelInClass } : undefined,
  )
  // The transition-aware dismiss. Always closes when invoked (e.g. an explicit
  // Cancel / X button via the children render-prop) — `dismissable` gates only
  // the implicit backdrop-click and Escape affordances below, not this.
  const close = useCallback(() => requestClose(onClose), [requestClose, onClose])

  // Trap Tab focus inside the panel and return focus to the opener on close.
  // `focusRef` wins; otherwise `initialFocus='panel'` lands on the container so a
  // display-only modal never rings a content control on open.
  useFocusTrap(panelRef, {
    initialFocusRef: focusRef ?? (initialFocus === 'panel' ? panelRef : undefined),
  })
  // Keep keyboard focus inside the modal across OS window blur/refocus.
  useRestoreFocus(panelRef, focusRef)

  useEffect(() => {
    if (!closeOnEscape || !dismissable) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // CONSUME the Escape (mirroring useCloseOnEscape) so it cannot also reach
      // the app's window-level shortcut handler, whose Escape branch falls
      // through to onConversationEscape (scroll-to-bottom + mark-read). Without
      // this, closing any default ModalOverlay modal opened over a conversation
      // would snap a reader scrolled up into history back to the newest message.
      e.stopPropagation()
      close()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [close, closeOnEscape, dismissable])

  return (
    <div
      data-modal="true"
      className={`fixed inset-0 flex ${ALIGN_CLASS[align]} justify-center z-50`}
    >
      {/* The scrim is a SIBLING of the panel, never its ancestor. An element
          with backdrop-filter forms a Backdrop Root, and a panel nested inside
          one has its own backdrop-filter silently discarded — the frost simply
          never paints. Keeping layout on the wrapper and frost on this layer is
          what lets the panel's blur sample the real app. The scrim also owns the
          fade now, so its transient opacity < 1 cannot form a backdrop root over
          the panel either. Guarded by ModalOverlay.backdroproot.test.tsx. */}
      <div aria-hidden="true" className={`absolute inset-0 modal-scrim ${scrimClass}`}>
        <div className="modal-scrim-aurora" />
      </div>
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        disabled={!dismissable}
        onClick={close}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={panelRef}
        {...panelProps}
        onKeyDown={onPanelKeyDown ? (e) => onPanelKeyDown(e, { close }) : undefined}
        className={`relative z-10 fluux-glass rounded-lg w-full ${width} mx-4 ${panelClass} ${panelClassName ?? ''}`}
      >
        {typeof children === 'function' ? children({ close }) : children}
      </div>
    </div>
  )
}
