import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useCloseOnEscape } from '@/hooks/useCloseOnEscape'
import { anchorMenuToTrigger } from '@/hooks/useAnchoredMenu'
import { messageMenuLayout } from './messageMenuLayout'

interface TouchMenuProps {
  open: boolean
  onClose: () => void
  anchor?: HTMLElement | null
  ariaLabel: string
  title?: ReactNode
  onBack?: () => void
  /** Rehome focus when the menu replaces its current view. */
  viewKey?: string
  returnFocusRef?: RefObject<HTMLButtonElement | null>
  expanded?: boolean
  reactions?: ReactNode
  preview?: ReactNode
  children: ReactNode
}

/** Portaled touch actions: escape message-row paint containment and stay beside the opener. */
export function TouchMenu({ open, onClose, anchor, ariaLabel, title, onBack, viewKey, returnFocusRef, expanded, reactions, preview, children }: TouchMenuProps) {
  const { t } = useTranslation()
  const backRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const reactionsRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const boundsRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, { active: open, includeShadowRoots: true })
  useCloseOnEscape(onBack ?? onClose, open)

  useLayoutEffect(() => {
    if (!open) return
    const target = backRef.current ?? returnFocusRef?.current
    if (target && panelRef.current?.contains(target)) target.focus({ preventScroll: true })
  }, [open, viewKey, returnFocusRef])

  useLayoutEffect(() => {
    const panel = panelRef.current
    const bounds = boundsRef.current
    if (!open || !panel || !bounds) return
    const viewport = window.visualViewport
    const place = () => {
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      const left = viewport?.offsetLeft ?? 0
      const top = viewport?.offsetTop ?? 0
      const safe = getComputedStyle(bounds)
      const insetLeft = parseFloat(safe.paddingLeft) || 12
      const insetRight = parseFloat(safe.paddingRight) || 12
      const insetTop = parseFloat(safe.paddingTop) || 12
      const insetBottom = parseFloat(safe.paddingBottom) || 12
      const availableWidth = Math.max(0, width - insetLeft - insetRight)
      const availableHeight = Math.max(0, height - insetTop - insetBottom)
      panel.style.maxWidth = `${availableWidth}px`
      panel.style.maxHeight = `${availableHeight}px`
      const rect = anchor?.getBoundingClientRect()
      const originX = left + insetLeft
      const originY = top + insetTop
      const previewContainer = previewRef.current
      const actions = actionsRef.current
      if (preview && rect && previewContainer && actions) {
        const menuWidth = Math.min(expanded ? 352 : 288, availableWidth)
        const previewWidth = Math.min(rect.width, availableWidth)
        panel.style.width = `${Math.max(previewWidth, menuWidth)}px`
        previewContainer.style.width = `${previewWidth}px`
        actions.style.width = `${menuWidth}px`
        if (reactionsRef.current) reactionsRef.current.style.width = `${menuWidth}px`
        const previewHeight = previewContainer.firstElementChild?.getBoundingClientRect().height ?? 0
        const layout = messageMenuLayout(
          rect,
          { left: originX, top: originY, width: availableWidth, height: availableHeight },
          reactionsRef.current?.getBoundingClientRect().height ?? 0,
          Math.max(actions.scrollHeight + 2, actions.getBoundingClientRect().height),
          previewHeight,
          menuWidth,
        )
        previewContainer.style.marginLeft = `${layout.previewOffset}px`
        previewContainer.style.maxHeight = `${layout.previewMaxHeight}px`
        previewContainer.dataset.truncated = String(previewHeight > layout.previewMaxHeight)
        actions.style.maxHeight = `${layout.actionsMaxHeight}px`
        panel.style.left = `${layout.x}px`
        panel.style.top = `${layout.y}px`
        return
      }
      const box = panel.getBoundingClientRect()
      const position = anchorMenuToTrigger(
        rect ? { left: rect.left - originX, top: rect.top - originY, bottom: rect.bottom - originY }
          : { left: 0, top: 0, bottom: 0 },
        box,
        { width: availableWidth, height: availableHeight },
        'down', 8, 0,
      )
      panel.style.left = `${originX + Math.min(position.x, Math.max(0, availableWidth - box.width))}px`
      const preferredY = preview && rect
        ? rect.top - originY - (reactionsRef.current?.getBoundingClientRect().height ?? 0) - (reactions ? 8 : 0)
        : position.y
      panel.style.top = `${originY + Math.max(0, Math.min(preferredY, Math.max(0, availableHeight - box.height)))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    if (previewRef.current?.firstElementChild) observer.observe(previewRef.current.firstElementChild)
    if (reactionsRef.current) observer.observe(reactionsRef.current)
    if (actionsRef.current) observer.observe(actionsRef.current)
    if (anchor) observer.observe(anchor)
    window.addEventListener('resize', place)
    // Capturing also follows a scrolled conversation without moving its scroll position.
    window.addEventListener('scroll', place, true)
    viewport?.addEventListener('resize', place)
    viewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      viewport?.removeEventListener('resize', place)
      viewport?.removeEventListener('scroll', place)
    }
  }, [open, anchor, expanded, preview, reactions])

  const header = onBack ? (
    <button ref={backRef} type="button" onClick={onBack} aria-label={t('common.back')}
      className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-start text-sm font-semibold text-fluux-text hover:bg-fluux-hover">
      <ChevronLeft className="size-4 shrink-0 rtl-mirror" />
      <span>{title ?? t('common.back')}</span>
    </button>
  ) : title ? <div className="px-3 py-2 text-sm font-semibold text-fluux-muted">{title}</div> : null

  if (!open) return null
  return createPortal(
    <div
      ref={boundsRef}
      data-modal="true"
      className="fixed inset-0 z-50"
      style={{ paddingTop: 'max(12px, env(safe-area-inset-top))', paddingBottom: 'max(12px, env(safe-area-inset-bottom))', paddingLeft: 'max(12px, env(safe-area-inset-left))', paddingRight: 'max(12px, env(safe-area-inset-right))' }}
      onClick={(event) => event.stopPropagation()}
    >
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/20" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`fixed overflow-y-auto overscroll-contain ${preview ? 'flex flex-col gap-2' : 'fluux-popover rounded-2xl p-1'} ${expanded ? 'w-[352px]' : 'w-72'}`}
      >
        {preview ? (
          <>
            {reactions && <div ref={reactionsRef} data-touch-menu-reactions className="shrink-0 fluux-popover rounded-full p-1">{reactions}</div>}
            <div ref={previewRef} className="relative shrink-0 overflow-hidden rounded-2xl group/preview">
              {preview}
              <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-6 bg-gradient-to-t from-fluux-float to-transparent group-data-[truncated=true]/preview:block" />
            </div>
            <div ref={actionsRef} data-touch-menu-actions className="shrink-0 overflow-y-auto overscroll-contain fluux-popover rounded-2xl p-1">{header}{children}</div>
          </>
        ) : <>{header}{children}</>}
      </div>
    </div>, document.body,
  )
}
