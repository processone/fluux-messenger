import { describe, it, expect } from 'vitest'
import { formatStartupCapabilities } from './startupDiagnostics'

describe('formatStartupCapabilities', () => {
  it('reports content-visibility support', () => {
    const line = formatStartupCapabilities(() => true, 'TestUA/1.0')
    expect(line).toContain('[StartupDiagnostics]')
    expect(line).toContain('content-visibility=supported')
    expect(line).toContain('TestUA/1.0')
  })

  it('reports missing content-visibility support', () => {
    const line = formatStartupCapabilities(
      (prop) => prop !== 'content-visibility',
      'OldWebKit/2.40'
    )
    expect(line).toContain('content-visibility=UNSUPPORTED')
  })

  it('survives a CSS.supports that throws (very old engines)', () => {
    const line = formatStartupCapabilities(() => {
      throw new Error('no CSS.supports')
    }, 'Ancient/0.1')
    expect(line).toContain('content-visibility=unknown')
  })
})
