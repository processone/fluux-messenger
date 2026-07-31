import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isUnsupportedMediaType, resetMediaSupportCache } from './mediaSupport'

/**
 * Stub a media engine: types listed here answer with the given verdict, every
 * other type answers '' (the definitive "no decoder").
 */
function stubEngine(support: Record<string, string>) {
  return vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(
    (type: string) => (support[type] ?? '') as CanPlayTypeResult,
  )
}

describe('isUnsupportedMediaType', () => {
  beforeEach(() => {
    resetMediaSupportCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports a container the engine cannot decode', () => {
    stubEngine({ 'video/mp4': 'maybe', 'video/webm': 'probably' })

    expect(isUnsupportedMediaType('video/x-matroska')).toBe(true)
  })

  it('does not report containers the engine accepts', () => {
    stubEngine({ 'video/mp4': 'maybe', 'video/webm': 'probably' })

    expect(isUnsupportedMediaType('video/mp4')).toBe(false)
    expect(isUnsupportedMediaType('video/webm')).toBe(false)
  })

  it('probes audio against an audio baseline', () => {
    stubEngine({ 'video/mp4': 'maybe', 'audio/mpeg': 'probably' })

    expect(isUnsupportedMediaType('audio/flac')).toBe(true)
    expect(isUnsupportedMediaType('audio/mpeg')).toBe(false)
  })

  it('stays silent when the engine answers nothing at all', () => {
    // jsdom, and any renderer without a media pipeline, says '' for every type
    // including the baseline. That is missing information, not a verdict.
    stubEngine({})

    expect(isUnsupportedMediaType('video/x-matroska')).toBe(false)
    expect(isUnsupportedMediaType('audio/flac')).toBe(false)
  })

  it('still answers on an engine that lacks the first baseline', () => {
    // A WebKitGTK build without the proprietary H.264 decoder plays WebM but
    // answers '' for MP4. Requiring MP4 alone would mute every verdict there.
    stubEngine({ 'video/webm': 'probably', 'audio/ogg': 'probably' })

    expect(isUnsupportedMediaType('video/x-matroska')).toBe(true)
    expect(isUnsupportedMediaType('video/webm')).toBe(false)
    expect(isUnsupportedMediaType('audio/x-ms-wma')).toBe(true)
  })

  it('ignores missing and non-media types', () => {
    stubEngine({ 'video/mp4': 'maybe' })

    expect(isUnsupportedMediaType(undefined)).toBe(false)
    expect(isUnsupportedMediaType('application/pdf')).toBe(false)
    expect(isUnsupportedMediaType('image/jpeg')).toBe(false)
  })

  it('asks the engine once per media type', () => {
    const canPlayType = stubEngine({ 'video/mp4': 'maybe' })

    isUnsupportedMediaType('video/x-matroska')
    isUnsupportedMediaType('video/x-matroska')

    // One baseline validation plus one answer for the queried type.
    expect(canPlayType.mock.calls.filter(([type]) => type === 'video/x-matroska')).toHaveLength(1)
  })
})
