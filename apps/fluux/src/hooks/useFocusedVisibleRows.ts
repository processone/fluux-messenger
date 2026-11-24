import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { BaseMessage } from '@fluux/sdk'
import { messageRowId } from '@/components/conversation/messageRowIdentity'
import { isViewportCovered } from './useViewportObserver'

/** A separate viewing callback on the shared observer; never writes read state. */
export function useFocusedVisibleRows<T extends BaseMessage>(
  scroller: RefObject<HTMLDivElement | null>, rows: readonly T[],
  onRows: ((rows: readonly T[]) => void) | undefined, enabled: boolean,
) {
  const byId = useMemo(() => new Map(rows.map(row => [messageRowId(row), row])), [rows])
  const latest = useRef({ byId, onRows, enabled, scroller })
  useLayoutEffect(() => { latest.current = { byId, onRows, enabled, scroller } }, [byId, onRows, enabled, scroller])
  return useCallback((ids: readonly string[]) => {
    const { byId, onRows, enabled, scroller } = latest.current
    const element = scroller.current
    if (!enabled || !onRows || !element?.isConnected || !document.hasFocus() || document.visibilityState !== 'visible'
      || isViewportCovered(element)) return
    const visible = ids.flatMap(id => { const row = byId.get(id); return row ? [row] : [] })
    if (visible.length) onRows(visible)
  }, [])
}
