import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createE2EEDiagnosticLogger } from './e2eeDiagnosticLogger'

describe('createE2EEDiagnosticLogger', () => {
  beforeEach(() => {
    // Module logger writes to console.* — silence to keep the suite stderr-clean.
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("writes to the sink with the 'e2ee' category and an [E2EE] prefix", () => {
    const events: { message: string; category?: string }[] = []
    const logger = createE2EEDiagnosticLogger({
      addEvent: (message, category) => events.push({ message, category }),
    })
    logger.warn('decrypt failed for example.com')
    expect(events).toHaveLength(1)
    expect(events[0].category).toBe('e2ee')
    expect(events[0].message).toBe('[E2EE] decrypt failed for example.com')
  })

  it('also forwards to the module logger (console)', () => {
    const logger = createE2EEDiagnosticLogger(undefined)
    logger.info('plugin registered: openpgp')
    expect(console.info).toHaveBeenCalledWith('[Fluux]', '[E2EE] plugin registered: openpgp')
  })

  it('tolerates an absent sink (headless SDK use)', () => {
    const logger = createE2EEDiagnosticLogger(undefined)
    expect(() => logger.debug('x')).not.toThrow()
  })

  it('appends an Error argument message', () => {
    const events: { message: string; category?: string }[] = []
    const logger = createE2EEDiagnosticLogger({
      addEvent: (message, category) => events.push({ message, category }),
    })
    logger.warn('probe failed openpgp example.com', new Error('timeout'))
    expect(events[0].message).toBe('[E2EE] probe failed openpgp example.com timeout')
  })
})
