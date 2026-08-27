import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Profiler } from 'react'
import { render, screen, act } from '@testing-library/react'
import { useDayBoundaryWatcher } from './useDayChange'
import {
  localDayKey,
  msUntilNextLocalMidnight,
  refreshCurrentDay,
  useCurrentDayStore,
} from '@/stores/currentDayStore'
import { DateSeparator } from '@/components/conversation/DateSeparator'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({ 'dates.today': 'Today', 'dates.yesterday': 'Yesterday' })[key] ?? key,
    i18n: { language: 'en' },
  }),
}))

/** Mounts the watcher alongside a label so both live under one render tree. */
function Harness({ date }: { date: string }) {
  useDayBoundaryWatcher()
  return <DateSeparator date={date} />
}

describe('day boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.setSystemTime(new Date())
    refreshCurrentDay()
  })

  describe('localDayKey', () => {
    it('formats the LOCAL calendar day, not the UTC one', () => {
      // 23:30 local on the 10th is already the 11th in UTC for any positive offset,
      // and still the 10th locally. The key must follow the local day.
      expect(localDayKey(new Date(2026, 1, 10, 23, 30))).toBe('2026-02-10')
      expect(localDayKey(new Date(2026, 1, 1, 0, 5))).toBe('2026-02-01')
    })
  })

  describe('msUntilNextLocalMidnight', () => {
    it('targets the next local midnight rather than a fixed 24h', () => {
      const now = new Date(2026, 1, 10, 23, 30, 0)
      expect(msUntilNextLocalMidnight(now)).toBe(30 * 60 * 1000)
    })

    it('lands exactly on local midnight from any time of day', () => {
      const now = new Date(2026, 1, 10, 6, 17, 42, 123)
      const landing = new Date(now.getTime() + msUntilNextLocalMidnight(now))
      expect(landing.getHours()).toBe(0)
      expect(landing.getMinutes()).toBe(0)
      expect(localDayKey(landing)).toBe('2026-02-11')
    })

    it('never returns a non-positive delay', () => {
      const now = new Date(2026, 1, 10, 23, 59, 59, 999)
      expect(msUntilNextLocalMidnight(now)).toBeGreaterThan(0)
    })
  })

  describe('refreshCurrentDay', () => {
    it('updates the day key when the wall clock has crossed midnight', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
      refreshCurrentDay()
      expect(useCurrentDayStore.getState().dayKey).toBe('2026-02-10')

      vi.setSystemTime(new Date(2026, 1, 11, 9, 0))
      refreshCurrentDay()
      expect(useCurrentDayStore.getState().dayKey).toBe('2026-02-11')
    })

    it('is a no-op within the same day (no subscriber notification)', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 8, 0))
      refreshCurrentDay()

      const seen: string[] = []
      const unsubscribe = useCurrentDayStore.subscribe((s) => seen.push(s.dayKey))

      vi.setSystemTime(new Date(2026, 1, 10, 23, 59))
      refreshCurrentDay()
      refreshCurrentDay()

      unsubscribe()
      expect(seen).toEqual([])
    })
  })

  describe('useDayChange', () => {
    it('re-renders the label when the day rolls over', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
      refreshCurrentDay()

      render(<DateSeparator date="2026-02-10" />)
      expect(screen.getByText('Today')).toBeTruthy()

      // The user leaves the window overnight and refocuses it the next morning;
      // useWindowVisibility calls refreshCurrentDay on that focus event.
      vi.setSystemTime(new Date(2026, 1, 11, 9, 0))
      act(() => {
        refreshCurrentDay()
      })

      expect(screen.queryByText('Today')).toBeNull()
      expect(screen.getByText('Yesterday')).toBeTruthy()
    })

    it("stops saying 'Yesterday' the day after", () => {
      vi.setSystemTime(new Date(2026, 1, 11, 10, 0))
      refreshCurrentDay()

      render(<DateSeparator date="2026-02-10" />)
      expect(screen.getByText('Yesterday')).toBeTruthy()

      vi.setSystemTime(new Date(2026, 1, 12, 10, 0))
      act(() => {
        refreshCurrentDay()
      })

      expect(screen.queryByText('Yesterday')).toBeNull()
      // Absolute labels are untouched: the old date now renders in full.
      expect(screen.getByText('February 10th, 2026')).toBeTruthy()
    })

    it('leaves an absolute label alone across a day change', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
      refreshCurrentDay()

      render(<DateSeparator date="2025-06-01" />)
      expect(screen.getByText('June 1st, 2025')).toBeTruthy()

      vi.setSystemTime(new Date(2026, 1, 11, 9, 0))
      act(() => {
        refreshCurrentDay()
      })

      expect(screen.getByText('June 1st, 2025')).toBeTruthy()
    })
  })

  describe('useDayBoundaryWatcher', () => {
    it('rolls the label over at local midnight with the window still focused', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
      refreshCurrentDay()

      render(<Harness date="2026-02-10" />)
      expect(screen.getByText('Today')).toBeTruthy()

      // No focus event is ever dispatched here — only wall-clock time passes.
      act(() => {
        vi.advanceTimersByTime(31 * 60 * 1000)
      })

      expect(screen.getByText('Yesterday')).toBeTruthy()
    })

    it('re-arms for each following midnight without drifting', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
      refreshCurrentDay()

      render(<Harness date="2026-02-10" />)

      act(() => {
        vi.advanceTimersByTime(31 * 60 * 1000)
      })
      expect(useCurrentDayStore.getState().dayKey).toBe('2026-02-11')

      act(() => {
        vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      })
      expect(useCurrentDayStore.getState().dayKey).toBe('2026-02-12')

      act(() => {
        vi.advanceTimersByTime(24 * 60 * 60 * 1000)
      })
      expect(useCurrentDayStore.getState().dayKey).toBe('2026-02-13')
    })

    it('does not re-render before the day actually changes', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 6, 0))
      refreshCurrentDay()

      const commits: string[] = []
      render(
        <Profiler id="day" onRender={(_id, phase) => commits.push(phase)}>
          <Harness date="2026-02-10" />
        </Profiler>
      )
      expect(commits).toEqual(['mount'])

      // Seventeen and a half hours of ordinary operation, well past any short
      // interval a naive implementation would have used: no update commit.
      act(() => {
        vi.advanceTimersByTime(17 * 60 * 60 * 1000 + 30 * 60 * 1000)
      })
      expect(commits).toEqual(['mount'])

      // One more hour crosses midnight: exactly one update.
      act(() => {
        vi.advanceTimersByTime(60 * 60 * 1000)
      })
      expect(commits).toEqual(['mount', 'update'])
    })

    it('clears its timer on unmount', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
      refreshCurrentDay()

      const { unmount } = render(<Harness date="2026-02-10" />)
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      unmount()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
