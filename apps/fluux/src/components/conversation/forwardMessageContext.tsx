import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ForwardMessageModal } from '../ForwardMessageModal'

const ForwardMessageContext = createContext<((link: string) => void) | null>(null)

/** Keep the picker alive when virtualized source rows leave the rendered range. */
export function ForwardMessageProvider({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const [target, setTarget] = useState<{ conversationId: string; link: string } | null>(null)
  useEffect(() => { setTarget(null) }, [conversationId])
  const open = useCallback((link: string) => setTarget({ conversationId, link }), [conversationId])
  return (
    <ForwardMessageContext.Provider value={open}>
      {children}
      {target?.conversationId === conversationId && (
        <ForwardMessageModal key={`${conversationId}:${target.link}`} link={target.link} onClose={() => setTarget(null)} />
      )}
    </ForwardMessageContext.Provider>
  )
}

export function useForwardMessage() {
  return useContext(ForwardMessageContext)
}
