import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { BaseMessage } from '@fluux/sdk'
import { messageRowId } from '@/components/conversation/messageRowIdentity'
import { isViewportCovered } from './useViewportObserver'

/** A separate viewing callback on the shared observer; never writes read state. */
export function useFocusedVisibleRows<T extends BaseMessage>(
  scroller: RefObject<HTMLDivElement | null>, rows: readonly T[],
  onRows: ((rows: readonly T[], isCurrent: () => boolean) => void) | undefined, enabled: boolean, conversationId: string,
) {
  const byId = useMemo(() => new Map(rows.map(row => [messageRowId(row), row])), [rows])
  const latest = useRef({ byId, onRows, enabled, scroller, conversationId })
  useLayoutEffect(() => { latest.current = { byId, onRows, enabled, scroller, conversationId } }, [byId, onRows, enabled, scroller, conversationId])
  return useCallback((ids: readonly string[], observerCurrent: () => boolean = () => true) => {
    const { byId, onRows, enabled, scroller, conversationId } = latest.current
    const element = scroller.current
    if (!enabled || !onRows || !element?.isConnected || !document.hasFocus() || document.visibilityState !== 'visible'
      || isViewportCovered(element)) return
    const visible = ids.flatMap(id => { const row = byId.get(id); return row ? [row] : [] })
    if (visible.length) onRows(visible, () => {
      const current = latest.current
      return observerCurrent() && current.conversationId === conversationId && ids.every(id => current.byId.has(id)) && current.enabled && !!current.onRows && current.scroller.current === element
        && element.isConnected && document.hasFocus() && document.visibilityState === 'visible' && !isViewportCovered(element)
    })
  }, [])
}
