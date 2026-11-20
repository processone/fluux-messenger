import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { ForwardMessageModal } from '../ForwardMessageModal'
import type { FileAttachment } from '@fluux/sdk'
import type { ForwardQuote } from '@/utils/forwardMessage'

/** What a forward carries: the room link, the readable source, and the file itself when the source has one. */
export interface ForwardTarget {
  link?: string
  quote?: ForwardQuote
  attachment?: FileAttachment
  /** The source was read from an end-to-end encrypted chat; it may only go into an encrypted chat. */
  fromEncrypted?: boolean
}

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
        <ForwardMessageModal key={`${conversationId}:${target.link ?? target.quote?.timestamp ?? target.attachment?.url}:${target.quote?.from ?? ''}`} link={target.link} quote={target.quote} attachment={target.attachment} fromEncrypted={target.fromEncrypted} onClose={() => setTarget(null)} />
      )}
    </ForwardMessageContext.Provider>
  )
}

export function useForwardMessage() {
  return useContext(ForwardMessageContext)
}
