import { useEffect, type RefObject } from 'react'
import type { BaseMessage } from '@fluux/sdk'
import { messageRowId } from '@/components/conversation/messageRowIdentity'

/** Independent viewing evidence for peer markers; never writes a local read pointer. */
export function useFocusedVisibleRows<T extends BaseMessage>(
  scroller: RefObject<HTMLDivElement | null>, rows: readonly T[],
  onRows: ((rows: readonly T[]) => void) | undefined, enabled: boolean,
) {
  useEffect(() => {
    const element = scroller.current
    if (!enabled || !onRows || !element) return
    const byId = new Map(rows.map(row => [messageRowId(row), row]))
    const measure = () => {
      if (!document.hasFocus() || document.visibilityState !== 'visible' || !element.isConnected
        || document.querySelector('[aria-modal="true"]')) return
      const viewport = element.getBoundingClientRect()
      const visible: T[] = []
      for (const node of element.querySelectorAll<HTMLElement>('[data-message-row-id]')) {
        const row = byId.get(node.dataset.messageRowId)
        if (!row) continue
        const rect = node.getBoundingClientRect()
        const overlap = Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top)
        if (rect.height > 0 && viewport.height > 0 && overlap >= Math.min(rect.height, viewport.height) / 2) visible.push(row)
      }
      if (visible.length) onRows(visible)
    }
    const observer = new IntersectionObserver(measure, { root: element, threshold: [0, 0.5, 1] })
    const observe = () => { observer.disconnect(); element.querySelectorAll('[data-message-row-id]').forEach(node => observer.observe(node)) }
    observe()
    const mutations = new MutationObserver(observe)
    mutations.observe(element, { childList: true, subtree: true })
    element.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('focus', measure)
    document.addEventListener('visibilitychange', measure)
    return () => {
      observer.disconnect(); mutations.disconnect()
      element.removeEventListener('scroll', measure)
      window.removeEventListener('focus', measure)
      document.removeEventListener('visibilitychange', measure)
    }
  }, [scroller, rows, onRows, enabled])
}
