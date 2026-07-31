/**
 * Browser media-format probing.
 *
 * `HTMLMediaElement.canPlayType()` answers `''`, `'maybe'` or `'probably'`.
 * Only the empty string is a definitive "no": the engine does not report
 * support for that MIME type.
 *
 * The answer is used to *explain* a playback failure, never to pre-empt one:
 * some engines under-report (Chromium answers `''` for `video/quicktime` yet
 * its demuxer handles the usual H.264 payload), so the element is always given
 * the chance to try first.
 */

/**
 * Reference types used to reject engines with no usable media pipeline.
 *
 * Several per kind, because no single codec is universal: a WebKitGTK build
 * without the proprietary H.264 decoder answers `''` for `video/mp4` while
 * playing WebM perfectly well. Requiring one type there would classify a real
 * engine as mute and silently disable every verdict below.
 */
const BASELINES: Record<'video' | 'audio', readonly string[]> = {
  video: ['video/mp4', 'video/webm', 'video/ogg'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav'],
}

const probes: Partial<Record<'video' | 'audio', HTMLMediaElement>> = {}
const answers = new Map<string, boolean>()

function getProbe(kind: 'video' | 'audio'): HTMLMediaElement | null {
  if (typeof document === 'undefined') return null

  const existing = probes[kind]
  if (existing) return existing

  const element = document.createElement(kind)
  if (typeof element.canPlayType !== 'function') return null

  // An engine with no media pipeline (jsdom, and any headless renderer) answers
  // `''` for everything, including every baseline. That is missing information,
  // not a verdict, so refuse to draw conclusions from it. One baseline hit is
  // enough to prove the engine answers meaningfully.
  if (!BASELINES[kind].some(type => element.canPlayType(type) !== '')) return null

  probes[kind] = element
  return element
}

/**
 * True when the browser explicitly reports it cannot decode `mediaType`.
 *
 * Returns false for unknown types, non-media types, and engines that give no
 * usable answer, so a caller can only ever act on a positive statement.
 */
export function isUnsupportedMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) return false

  const cached = answers.get(mediaType)
  if (cached !== undefined) return cached

  const kind = mediaType.startsWith('video/')
    ? 'video'
    : mediaType.startsWith('audio/')
      ? 'audio'
      : null
  if (!kind) return false

  const probe = getProbe(kind)
  if (!probe) return false

  const unsupported = probe.canPlayType(mediaType) === ''
  answers.set(mediaType, unsupported)
  return unsupported
}

/** Test seam: drop the cached probes and answers. */
export function resetMediaSupportCache(): void {
  delete probes.video
  delete probes.audio
  answers.clear()
}
