import { useEffect, useState } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderLoopBoundary } from '../components/RenderLoopBoundary'
import { __setClock, detectRenderLoop, getRenderStats, resetRenderLoopDetector, startSyncGracePeriod } from './renderLoopDetector'

vi.unmock('@/utils/renderLoopDetector')

function EffectLoop({ onRender }: { onRender: () => void }) {
  onRender()
  detectRenderLoop('EffectLoop')
  const [value, setValue] = useState(0)
  useEffect(() => { setValue(value + 1) }, [value])
  return <span>{value}</span>
}

describe('render loop hard break', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRenderLoopDetector()
    __setClock(() => 5_000_000)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    resetRenderLoopDetector()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    [0, false, 201],
    [0, true, 501],
    [0.01, false, 201],
    [0.01, true, 501],
  ] as const)('breaks an effect loop at %ims/render (sync grace: %s)', (stepMs, syncGrace, count) => {
    let t = 5_000_000
    __setClock(() => t)
    if (syncGrace) startSyncGracePeriod()
    render(<RenderLoopBoundary><EffectLoop onRender={() => { t += stepMs }} /></RenderLoopBoundary>)
    expect(screen.getByText('Render Loop Detected')).toBeInTheDocument()
    expect(getRenderStats().EffectLoop).toMatchObject({ count, triggered: true })
  })

  it.each([
    [1, false],
    [2, false],
    [1, true],
    [2, true],
  ] as const)('breaks a sustained effect loop at %ims/render (sync grace: %s)', (stepMs, syncGrace) => {
    let t = 5_000_000
    __setClock(() => t)
    if (syncGrace) startSyncGracePeriod()
    const expectedDuration = syncGrace && stepMs === 2 ? 20_000 : 5000
    render(
      <RenderLoopBoundary>
        <EffectLoop onRender={() => {
          t += stepMs
          if (t > 5_000_000 + expectedDuration + 1000) throw new Error('Effect loop exceeded the detection deadline')
        }} />
      </RenderLoopBoundary>
    )
    expect(screen.getByText('Render Loop Detected')).toBeInTheDocument()
    expect(screen.getByText(/sustained .* renders\/sec for 5000ms/)).toBeInTheDocument()
    expect(t - 5_000_000).toBeGreaterThanOrEqual(expectedDuration)
    expect(t - 5_000_000).toBeLessThan(expectedDuration + 100)
    expect(getRenderStats().EffectLoop.triggered).toBe(true)
  })
})
