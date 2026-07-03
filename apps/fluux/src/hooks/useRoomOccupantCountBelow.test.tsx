import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: vi.fn(),
}))

import { useRoomStore } from '@fluux/sdk/react'
import { useRoomOccupantCountBelow } from './useRoomOccupantCountBelow'

const mockedUseRoomStore = useRoomStore as unknown as ReturnType<typeof vi.fn>

const JID = 'room@conf.example.com'

/** Seed the runtime map with a room holding `size` occupants. */
function mockOccupantCount(size: number) {
  const occupants = new Map(Array.from({ length: size }, (_, i) => [`u${i}`, { nick: `u${i}` }]))
  mockedUseRoomStore.mockImplementation((selector: (s: unknown) => unknown) =>
    selector({ roomRuntime: new Map([[JID, { occupants }]]) }),
  )
}

describe('useRoomOccupantCountBelow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns true when the count is below the threshold', () => {
    mockOccupantCount(5)
    const { result } = renderHook(() => useRoomOccupantCountBelow(JID, 30))
    expect(result.current).toBe(true)
  })

  it('returns false at the threshold (strict less-than)', () => {
    mockOccupantCount(30)
    const { result } = renderHook(() => useRoomOccupantCountBelow(JID, 30))
    expect(result.current).toBe(false)
  })

  it('returns false above the threshold', () => {
    mockOccupantCount(97)
    const { result } = renderHook(() => useRoomOccupantCountBelow(JID, 30))
    expect(result.current).toBe(false)
  })

  it('returns true for a missing room (count 0)', () => {
    mockedUseRoomStore.mockImplementation((selector: (s: unknown) => unknown) =>
      selector({ roomRuntime: new Map() }),
    )
    const { result } = renderHook(() => useRoomOccupantCountBelow(JID, 30))
    expect(result.current).toBe(true)
  })

  it('yields the SAME boolean for different sub-threshold counts (flips only at the boundary)', () => {
    // This is the point of the hook: join/leave churn under the threshold must not
    // change the derived value, so Zustand's Object.is check bails the re-render.
    mockOccupantCount(3)
    const { result: a } = renderHook(() => useRoomOccupantCountBelow(JID, 30))
    mockOccupantCount(29)
    const { result: b } = renderHook(() => useRoomOccupantCountBelow(JID, 30))
    expect(a.current).toBe(true)
    expect(b.current).toBe(true)
  })
})
