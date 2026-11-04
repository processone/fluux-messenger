import { useEffect, useRef } from 'react'
import type { ConnectionStatus } from '@fluux/sdk'
import { useWrappedCodeBlocksStore } from '@/stores/wrappedCodeBlocksStore'

/**
 * Forget every "Wrap lines" choice when the account changes: on logout, or when
 * a different account comes online. A transient drop ('reconnecting') keeps them.
 * Message ids are only unique per account, so stale choices must not leak into
 * the next session.
 */
export function useForgetWrapOnAccountChange(status: ConnectionStatus, jid: string | null): void {
  const accountRef = useRef<string | null>(null)
  useEffect(() => {
    if (status === 'disconnected') {
      accountRef.current = null
      useWrappedCodeBlocksStore.getState().clear()
      return
    }
    const account = jid ? jid.split('/')[0] : null
    if (!account) return
    if (accountRef.current !== null && accountRef.current !== account) useWrappedCodeBlocksStore.getState().clear()
    accountRef.current = account
  }, [status, jid])
}
