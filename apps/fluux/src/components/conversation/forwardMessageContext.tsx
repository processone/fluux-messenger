import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ForwardMessageModal } from '../ForwardMessageModal'
import type { ForwardQuote } from '@/utils/forwardMessage'

export interface ForwardTarget { link: string; quote?: ForwardQuote }

const ForwardMessageContext = createContext<((target: ForwardTarget) => void) | null>(null)

/** Keep the picker alive when virtualized source rows leave the rendered range. */
export function ForwardMessageProvider({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const [target, setTarget] = useState<(ForwardTarget & { conversationId: string }) | null>(null)
  useEffect(() => { setTarget(null) }, [conversationId])
  const open = useCallback((next: ForwardTarget) => setTarget({ conversationId, ...next }), [conversationId])
  return (
    <ForwardMessageContext.Provider value={open}>
      {children}
      {target?.conversationId === conversationId && (
        <ForwardMessageModal key={`${conversationId}:${target.link}`} link={target.link} quote={target.quote} onClose={() => setTarget(null)} />
      )}
    </ForwardMessageContext.Provider>
  )
}

export function useForwardMessage() {
  return useContext(ForwardMessageContext)
}
