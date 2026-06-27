import { describe, it, expect, beforeEach } from 'vitest'
import { useLoginPrefillStore } from './loginPrefillStore'

describe('loginPrefillStore', () => {
  beforeEach(() => {
    useLoginPrefillStore.getState().clearPrefill()
  })

  it('starts empty', () => {
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
  })

  it('stores a prefill', () => {
    useLoginPrefillStore.getState().setPrefill({ jid: 'a@b.com', server: 'wss://b.com/ws' })
    expect(useLoginPrefillStore.getState().prefill).toEqual({ jid: 'a@b.com', server: 'wss://b.com/ws' })
  })

  it('clears a prefill', () => {
    useLoginPrefillStore.getState().setPrefill({ jid: 'a@b.com' })
    useLoginPrefillStore.getState().clearPrefill()
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
  })
})
