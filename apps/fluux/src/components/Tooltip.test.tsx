import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Tooltip, SimpleTooltip } from './Tooltip'
import { dismissAllTooltips } from '../utils/tooltipBus'

describe('Tooltip', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('visibility', () => {
    it('should not show tooltip initially', () => {
      render(
        <Tooltip content="Test tooltip">
          <button>Hover me</button>
        </Tooltip>
      )

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })

    it('should show tooltip after hover delay', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip content="Test tooltip" delay={400}>
          <button>Hover me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Hover me').parentElement!
      fireEvent.mouseEnter(trigger)

      // Not visible yet
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

      // Advance past delay
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      expect(screen.getByRole('tooltip')).toHaveTextContent('Test tooltip')
    })

    it('should hide tooltip on mouse leave', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip content="Test tooltip" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Hover me').parentElement!
      fireEvent.mouseEnter(trigger)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      fireEvent.mouseLeave(trigger)

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })

    it('should not show tooltip if mouse leaves before delay', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip content="Test tooltip" delay={500}>
          <button>Hover me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Hover me').parentElement!
      fireEvent.mouseEnter(trigger)

      // Leave before delay completes
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      fireEvent.mouseLeave(trigger)

      // Complete the delay
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })
  })

  describe('global dismiss (tooltip bus)', () => {
    it('hides a visible tooltip when dismissAllTooltips() fires', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip content="Test tooltip" delay={0}>
          <button>Hover me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Hover me').parentElement!
      fireEvent.mouseEnter(trigger)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      act(() => {
        dismissAllTooltips()
      })

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })

    it('cancels a pending tooltip so it never appears over a modal', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip content="Test tooltip" delay={500}>
          <button>Hover me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Hover me').parentElement!
      fireEvent.mouseEnter(trigger)

      // Delay still counting down — a modal opens and dismisses tooltips.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      act(() => {
        dismissAllTooltips()
      })

      // Complete the original delay: the tooltip must NOT pop up afterwards.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })
  })

  describe('disabled state', () => {
    it('should not show tooltip when disabled', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip content="Test tooltip" delay={0} disabled>
          <button>Hover me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Hover me').parentElement!
      fireEvent.mouseEnter(trigger)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })
  })

  describe('positions', () => {
    it.each(['top', 'bottom', 'left', 'right'] as const)(
      'should accept position=%s',
      async (position) => {
        vi.useFakeTimers()
        render(
          <Tooltip content="Test tooltip" position={position} delay={0}>
            <button>Hover me</button>
          </Tooltip>
        )

        const trigger = screen.getByText('Hover me').parentElement!
        fireEvent.mouseEnter(trigger)

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0)
        })

        expect(screen.getByRole('tooltip')).toBeInTheDocument()
      }
    )
  })

  describe('rich content', () => {
    it('should render ReactNode content', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip
          content={
            <span>
              Rich <strong>content</strong>
            </span>
          }
          delay={0}
        >
          <button>Hover me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Hover me').parentElement!
      fireEvent.mouseEnter(trigger)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      const tooltip = screen.getByRole('tooltip')
      expect(tooltip).toContainHTML('<strong>content</strong>')
    })
  })

  describe('accessibility', () => {
    it('should show tooltip on focus', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip content="Test tooltip" delay={0}>
          <button>Focus me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Focus me').parentElement!
      fireEvent.focus(trigger)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.getByRole('tooltip')).toBeInTheDocument()
    })

    it('should hide tooltip on blur', async () => {
      vi.useFakeTimers()
      render(
        <Tooltip content="Test tooltip" delay={0}>
          <button>Focus me</button>
        </Tooltip>
      )

      const trigger = screen.getByText('Focus me').parentElement!
      fireEvent.focus(trigger)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.getByRole('tooltip')).toBeInTheDocument()

      fireEvent.blur(trigger)

      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })
  })
})

describe('SimpleTooltip', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('should render with string content', async () => {
    vi.useFakeTimers()
    render(
      <SimpleTooltip content="Simple tooltip" delay={0}>
        <button>Hover me</button>
      </SimpleTooltip>
    )

    const trigger = screen.getByText('Hover me').parentElement!
    fireEvent.mouseEnter(trigger)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByRole('tooltip')).toHaveTextContent('Simple tooltip')
  })
})
