import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { useRef } from 'react'
import { MessageWidthProvider, useRemeasureOnWidthChange } from './messageWidthContext'

// Capture the ResizeObserver callback so the test can simulate resize "fires".
let roCallback: ResizeObserverCallback | null = null
class MockResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    roCallback = cb
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The provider reads `containerEl.clientWidth`; control it via a stubbed getter.
let stubbedWidth = 100
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

function Consumer({ onRemeasure }: { onRemeasure: () => void }) {
  useRemeasureOnWidthChange(onRemeasure)
  return null
}

function Harness({ onRemeasure }: { onRemeasure: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref}>
      <MessageWidthProvider containerRef={ref}>
        <Consumer onRemeasure={onRemeasure} />
      </MessageWidthProvider>
    </div>
  )
}

describe('MessageWidthProvider / useRemeasureOnWidthChange', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    roCallback = null
    stubbedWidth = 100
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => stubbedWidth })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  })

  it('coalesces multiple width changes into a single debounced notification', () => {
    const onRemeasure = vi.fn()
    render(<Harness onRemeasure={onRemeasure} />)
    expect(roCallback).toBeTypeOf('function')

    // Simulate a drag-resize: several width changes in quick succession.
    stubbedWidth = 200
    roCallback!([], {} as ResizeObserver)
    stubbedWidth = 300
    roCallback!([], {} as ResizeObserver)
    // Debounced — nothing yet.
    expect(onRemeasure).not.toHaveBeenCalled()

    // After the resize settles → exactly one re-measure (not one per fire).
    vi.advanceTimersByTime(200)
    expect(onRemeasure).toHaveBeenCalledTimes(1)
  })

  it('ignores height-only changes (width unchanged)', () => {
    const onRemeasure = vi.fn()
    render(<Harness onRemeasure={onRemeasure} />)

    // Same width (100) — a height-only resize fire. Must not notify.
    roCallback!([], {} as ResizeObserver)
    vi.advanceTimersByTime(200)
    expect(onRemeasure).not.toHaveBeenCalled()
  })

  it('is a no-op (does not throw) without a provider', () => {
    const onRemeasure = vi.fn()
    expect(() => render(<Consumer onRemeasure={onRemeasure} />)).not.toThrow()
  })
})
