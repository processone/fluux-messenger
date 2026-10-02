import { useCallback, useRef } from 'react'
import { useRemeasureOnWidthChange } from './messageWidthContext'
import { predictMessageTextHeight, type FontSpec } from '@/utils/messageHeight/predictMessageTextHeight'
import { estimateDebugLog } from '@/utils/scrollDebug'
import type { RowEstimatorContext, RowChrome } from './rowHeightEstimator'

const FALLBACK_FONT: FontSpec = {
  fontFamily: 'Inter, sans-serif',
  fontSizePx: 16,
  fontWeight: 400,
  fontStyle: 'normal',
  lineHeightPx: 22,
  letterSpacingPx: 0,
  whiteSpace: 'pre-wrap',
}

const FALLBACK_CHROME: RowChrome = {
  header: 40,
  continuation: 6,
  reactionsRow: 28,
  newMarker: 48,
  date: 48,
  loadEarlierHeader: 52,
  footer: 40,
}

export const ROW_METRICS_FALLBACK: RowEstimatorContext = {
  fontSpec: FALLBACK_FONT,
  contentWidthPx: 560,
  lineBoxPx: 22,
  chrome: FALLBACK_CHROME,
}

/**
 * Pick the text element whose clientWidth is the conversation's real CONTENT width.
 *
 * Own bubbles are `w-fit` (hug width): their `[data-msg-text]` is only as wide as the text,
 * so sampling whichever row happens to be first poisons the width (and therefore the height
 * cache's width-bucket validity tag) with an essentially random value. Prefer the first text
 * element OUTSIDE `[data-msg-own]`; if only own rows are mounted, the widest own text box is
 * the best available lower bound.
 */
export function pickWidthSampleEl(root: HTMLElement): HTMLElement | null {
  const all = root.querySelectorAll<HTMLElement>('[data-msg-text]')
  let widestOwn: HTMLElement | null = null
  for (const el of all) {
    if (!el.closest('[data-msg-own]')) return el
    if (!widestOwn || el.clientWidth > widestOwn.clientWidth) widestOwn = el
  }
  return widestOwn
}

/**
 * Pick a row for chrome sampling (chrome = outer height − predicted text height): it must be
 * a PLAIN-TEXT row. Any other content makes the prediction meaningless (observed: a
 * continuation "chrome" of 369px vs the real ~6px), and own hug-width rows wrap at the bubble
 * width rather than the content width. Returns the first clean row of the shape, or null.
 */
export function pickChromeSampleEl(
  root: HTMLElement,
  shape: 'header' | 'cont',
): HTMLElement | null {
  const rows = root.querySelectorAll<HTMLElement>(`[data-msg-chrome="${shape}"]`)
  for (const row of rows) {
    if (row.hasAttribute('data-msg-own')) continue
    if (isPlainTextRow(row, shape)) return row
  }
  return null
}

/**
 * A plain-text row holds the sender header (header rows only) followed by a body whose only
 * element is the text. Whatever else a message shows (reply quote card, attachment, link
 * preview, poll, reactions, delivery error, collapsed long body) adds height the text predictor
 * cannot see. Re-windowing changes which row is mounted first, so admitting such a row makes
 * the sampled chrome alternate between row shapes.
 */
function isPlainTextRow(row: HTMLElement, shape: 'header' | 'cont'): boolean {
  const text = row.querySelector('[data-msg-text]')
  if (!text || text.querySelector('blockquote, pre, img, video, audio')) return false
  let body: Element = text
  while (body.parentElement !== row) {
    const parent = body.parentElement
    if (!parent || parent.childElementCount !== 1) return false
    body = parent
  }
  if (body === text || body !== row.lastElementChild) return false
  const header = body.previousElementSibling
  if (shape === 'cont') return header === null
  return header !== null && header.hasAttribute('data-msg-sender') && header.previousElementSibling === null
}

function fontSpecFrom(el: HTMLElement): FontSpec {
  const cs = getComputedStyle(el)
  const fontSizePx = parseFloat(cs.fontSize) || 16
  const lh =
    cs.lineHeight === 'normal'
      ? fontSizePx * 1.375
      : parseFloat(cs.lineHeight) || fontSizePx * 1.375
  const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0
  return {
    fontFamily: cs.fontFamily || 'Inter, sans-serif',
    fontSizePx,
    fontWeight: Number(cs.fontWeight) || 400,
    fontStyle: cs.fontStyle || 'normal',
    lineHeightPx: lh,
    letterSpacingPx: ls,
    whiteSpace: 'pre-wrap',
  }
}

/**
 * Accepted samples that notify per content width, line box and font. The first sample sets the
 * geometry and the next ones correct the chrome; a row shape the sampler fails to exclude would
 * otherwise recalibrate on every re-window.
 */
export const MAX_CALIBRATIONS_PER_GEOMETRY = 3

export interface RowMetrics {
  /** The latest sample; estimates read it without requiring hook state updates. */
  metricsRef: React.RefObject<RowEstimatorContext>
  sample: () => void
}

/**
 * Samples the live row metrics needed to estimate unmounted rows: the body FontSpec, the text
 * content width, the rendered line box (WebKit floors line boxes; we read the real box), and the
 * per-shape chrome deltas (chrome = a mounted row's outer height minus its predicted text height).
 * Returns the metrics ref and a sampler called by mounted-row measurement and the width signal.
 * Before the first positive-width text sample, metrics retain the fallback. The first successful sample
 * and subsequent metric changes notify onCalibrated after updating the ref; identical samples do not,
 * and neither do chrome-only changes past MAX_CALIBRATIONS_PER_GEOMETRY. `first` marks the first
 * calibration of the mount.
 */
export function useRowMetrics(
  scrollRef: React.RefObject<HTMLElement | null>,
  onCalibrated?: (first: boolean) => void,
): RowMetrics {
  const ctxRef = useRef<RowEstimatorContext>(ROW_METRICS_FALLBACK)
  const calibrationsRef = useRef(0)
  const onCalibratedRef = useRef(onCalibrated)
  onCalibratedRef.current = onCalibrated

  const sample = useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    const textEl = pickWidthSampleEl(root)
    if (!textEl || textEl.clientWidth <= 0) return
    const fontSpec = fontSpecFrom(textEl)
    const contentWidthPx = textEl.clientWidth

    // Line box height: primary = floor(lineHeightPx) — the engine-correct rendered box (WebKit
    // floors line boxes to integer px; floor(lineHeight) matches the real box for font-size
    // combinations that don't land on a pixel boundary). We refine to the measured height of a
    // single-line element only when it is in the expected single-line range (<= ceil(lineHeight))
    // — a multi-line measurement would produce an inflated value and must be ignored.
    const measuredBox = Math.round(textEl.getBoundingClientRect().height)
    const lineBoxPx =
      measuredBox > 0 && measuredBox <= Math.ceil(fontSpec.lineHeightPx)
        ? measuredBox
        : Math.floor(fontSpec.lineHeightPx)

    // Chrome deltas: outer row height minus predicted text height for header and continuation rows.
    const chrome: RowChrome = { ...ctxRef.current.chrome }

    const measureChromeFor = (shape: 'header' | 'cont'): number | null => {
      const rowEl = pickChromeSampleEl(root, shape)
      const t = rowEl?.querySelector<HTMLElement>('[data-msg-text]')
      if (!rowEl || !t) return null
      const outer = rowEl.getBoundingClientRect().height
      const predicted = predictMessageTextHeight(
        t.textContent ?? '',
        contentWidthPx,
        fontSpec,
        lineBoxPx,
      ).heightPx
      return Math.max(0, Math.round(outer - predicted))
    }

    const h = measureChromeFor('header')
    if (h != null) chrome.header = h
    const c = measureChromeFor('cont')
    if (c != null) chrome.continuation = c

    // Structural rows tagged by kind.
    const dateEl = root.querySelector<HTMLElement>('[data-row-kind="date"]')
    if (dateEl) chrome.date = Math.round(dateEl.getBoundingClientRect().height)
    const footEl = root.querySelector<HTMLElement>('[data-row-kind="footer"]')
    if (footEl) chrome.footer = Math.round(footEl.getBoundingClientRect().height)

    const previous = ctxRef.current
    const first = previous === ROW_METRICS_FALLBACK
    const sameGeometry = !first &&
      previous.contentWidthPx === contentWidthPx && previous.lineBoxPx === lineBoxPx &&
      Object.entries(fontSpec).every(([key, value]) => previous.fontSpec[key as keyof FontSpec] === value)
    if (sameGeometry &&
      Object.entries(chrome).every(([key, value]) => previous.chrome[key as keyof RowChrome] === value)) return
    ctxRef.current = { fontSpec, contentWidthPx, lineBoxPx, chrome }
    calibrationsRef.current = sameGeometry ? calibrationsRef.current + 1 : 1
    estimateDebugLog('sample', {
      fontSizePx: fontSpec.fontSizePx,
      lineHeightPx: fontSpec.lineHeightPx,
      contentWidthPx,
      lineBoxPx,
      chrome,
    })
    if (calibrationsRef.current > MAX_CALIBRATIONS_PER_GEOMETRY) return
    onCalibratedRef.current?.(first)
  }, [scrollRef])

  useRemeasureOnWidthChange(sample)

  return { metricsRef: ctxRef, sample }
}
