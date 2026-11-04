import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ConnectionStatus } from '@fluux/sdk'
import { useForgetWrapOnAccountChange } from './useForgetWrapOnAccountChange'
import { useWrappedCodeBlocksStore } from '@/stores/wrappedCodeBlocksStore'

// Source: captain's choice on review FLM-404 R2 — forget all wrap choices when the account changes.
describe('useForgetWrapOnAccountChange', () => {
  beforeEach(() => useWrappedCodeBlocksStore.getState().clear())
  const wrapOne = () => useWrappedCodeBlocksStore.getState().toggle('k', 0)
  const isWrapped = () => useWrappedCodeBlocksStore.getState().isWrapped('k', 0)
  const setup = (status: ConnectionStatus, jid: string | null) =>
    renderHook((p: { status: ConnectionStatus; jid: string | null }) => useForgetWrapOnAccountChange(p.status, p.jid), { initialProps: { status, jid } })

  it('keeps choices across a transient reconnect of the same account (any resource)', () => {
    const { rerender } = setup('online', 'me@x.org/phone')
    wrapOne()
    rerender({ status: 'reconnecting', jid: 'me@x.org/phone' })
    rerender({ status: 'online', jid: 'me@x.org/laptop' })
    expect(isWrapped()).toBe(true)
  })

  it('forgets them on logout', () => {
    const { rerender } = setup('online', 'me@x.org/phone')
    wrapOne()
    rerender({ status: 'disconnected', jid: null })
    expect(isWrapped()).toBe(false)
  })

  it('forgets them when a different account comes online without a disconnect in between', () => {
    const { rerender } = setup('online', 'me@x.org/phone')
    wrapOne()
    rerender({ status: 'online', jid: 'other@x.org/phone' })
    expect(isWrapped()).toBe(false)
  })

  it('does not forget on the first login of a session', () => {
    setup('connecting', null)
    wrapOne()
    const { rerender } = setup('online', 'me@x.org/a')
    rerender({ status: 'online', jid: 'me@x.org/a' })
    expect(isWrapped()).toBe(true)
  })
})
