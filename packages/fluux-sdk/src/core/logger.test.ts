import { describe, it, expect, vi, afterEach } from 'vitest'
import { logDebug, logInfo, logWarn, logError, setLogSink, type LogLevel } from './logger'

afterEach(() => {
  setLogSink(null)
  vi.restoreAllMocks()
})

describe('log sink', () => {
  it('writes to the console with the [Fluux] prefix by default', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    logInfo('connected')
    expect(info).toHaveBeenCalledWith('[Fluux]', 'connected')
  })

  it('sends every level to an installed sink, tagged and unprefixed', () => {
    const seen: Array<[LogLevel, string]> = []
    setLogSink((level, message) => seen.push([level, message]))

    logDebug('d')
    logInfo('i')
    logWarn('w')
    logError('e')

    expect(seen).toEqual([
      ['debug', 'd'],
      ['info', 'i'],
      ['warn', 'w'],
      ['error', 'e'],
    ])
  })

  it('leaves the console alone while a sink is installed', () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    setLogSink(() => {})

    logDebug('d')
    logInfo('i')
    logWarn('w')
    logError('e')

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('restores the console when the sink is removed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setLogSink(() => {})
    setLogSink(null)

    logWarn('back')
    expect(warn).toHaveBeenCalledWith('[Fluux]', 'back')
  })
})
