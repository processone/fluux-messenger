import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: vi.fn(),
}))

import { useRoomStore } from '@fluux/sdk/react'
import { useWhisperCounterpartPresent } from './useWhisperCounterpartPresent'
import type { WhisperTarget } from '@/components/conversation'

const mockedUseRoomStore = useRoomStore as unknown as ReturnType<typeof vi.fn>

const JID = 'room@conf.example.com'

function mockOccupants(occ: Map<string, { occupantId?: string }>) {
  mockedUseRoomStore.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ roomRuntime: new Map([[JID, { occupants: occ }]]) }),
  )
}

describe('useWhisperCounterpartPresent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns false when there is no whisper target', () => {
    mockOccupants(new Map())
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, null))
    expect(result.current).toBe(false)
  })

  it('returns true when the counterpart is present (by nick)', () => {
    mockOccupants(new Map([['bob', {}]]))
    const target: WhisperTarget = { nick: 'bob' }
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, target))
    expect(result.current).toBe(true)
  })

  it('returns false when the counterpart has left', () => {
    mockOccupants(new Map([['alice', {}]]))
    const target: WhisperTarget = { nick: 'bob' }
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, target))
    expect(result.current).toBe(false)
  })

  it('matches on occupant-id, not a recycled nick', () => {
    mockOccupants(new Map([['bob', { occupantId: 'newperson' }]]))
    const target: WhisperTarget = { nick: 'bob', occupantId: 'original' }
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, target))
    expect(result.current).toBe(false)
  })

  it('returns false when target is undefined', () => {
    mockOccupants(new Map())
    const { result } = renderHook(() => useWhisperCounterpartPresent(JID, undefined))
    expect(result.current).toBe(false)
  })
})
