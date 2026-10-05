import { describe, it, expect, vi, afterEach } from 'vitest'
import { ARRIVAL_JUMP_TTL_MS, decideArrivalJump, useArrivalJumpStore, type ArrivalJump } from './arrivalJumpStore'

const jump: ArrivalJump = { conversationId: 'alice@example.com', requestedAt: 1_000 }
const facts = {
  jump,
  conversationId: 'alice@example.com',
  targetRowId: 'm1',
  isCatchingUp: false,
  lastUserInputAt: 0,
}

describe('decideArrivalJump', () => {
  it('jumps once a new message is there and catch-up is done', () => {
    expect(decideArrivalJump(facts)).toBe('jump')
  })

  it('waits while catch-up runs or before a new message arrives', () => {
    expect(decideArrivalJump({ ...facts, isCatchingUp: true })).toBe('wait')
    expect(decideArrivalJump({ ...facts, targetRowId: undefined })).toBe('wait')
  })

  it('drops the jump once the reader scrolled after the request', () => {
    expect(decideArrivalJump({ ...facts, lastUserInputAt: 2_000 })).toBe('cancel')
    expect(decideArrivalJump({ ...facts, lastUserInputAt: 500 })).toBe('jump')
  })

  it('ignores a jump meant for another conversation, or none', () => {
    expect(decideArrivalJump({ ...facts, conversationId: 'bob@example.com' })).toBeNull()
    expect(decideArrivalJump({ ...facts, jump: null })).toBeNull()
  })
})

describe('useArrivalJumpStore', () => {
  afterEach(() => {
    vi.useRealTimers()
    useArrivalJumpStore.setState({ jump: null })
  })

  it('forgets a jump that was not carried out in time', () => {
    vi.useFakeTimers()
    useArrivalJumpStore.getState().request('alice@example.com')
    expect(useArrivalJumpStore.getState().jump?.conversationId).toBe('alice@example.com')

    vi.advanceTimersByTime(ARRIVAL_JUMP_TTL_MS)

    expect(useArrivalJumpStore.getState().jump).toBeNull()
  })

  it('keeps a newer jump when an older one is cleared', () => {
    useArrivalJumpStore.getState().request('alice@example.com', 1)
    const first = useArrivalJumpStore.getState().jump!
    useArrivalJumpStore.getState().request('bob@example.com', 2)

    useArrivalJumpStore.getState().clear(first)

    expect(useArrivalJumpStore.getState().jump?.conversationId).toBe('bob@example.com')
  })
})
