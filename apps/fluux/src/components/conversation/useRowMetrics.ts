import { useCallback, useEffect, useRef } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useRemeasureOnWidthChange } from './messageWidthContext'
import { predictMessageTextHeight, type FontSpec } from '@/utils/messageHeight/predictMessageTextHeight'
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
 * Samples the live row metrics needed to estimate unmounted rows: the body FontSpec, the text
 * content width, the rendered line box (WebKit floors line boxes; we read the real box), and the
 * per-shape chrome deltas (chrome = a mounted row's outer height minus its predicted text height).
 * Self-calibrating: density / character-scale / theme need no hardcoded tables. Returns a ref
 * (no re-render). Re-samples when the width signal fires or settings (fontSize / densityMode) change.
 */
export function useRowMetrics(
  scrollRef: React.RefObject<HTMLElement | null>,
): React.RefObject<RowEstimatorContext> {
  const ctxRef = useRef<RowEstimatorContext>(ROW_METRICS_FALLBACK)
  const fontSize = useSettingsStore((s) => s.fontSize)
  const densityMode = useSettingsStore((s) => s.densityMode)

  const sample = useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    const textEl = root.querySelector<HTMLElement>('[data-msg-text]')
    if (!textEl) return // nothing mounted yet; keep current/fallback

    const fontSpec = fontSpecFrom(textEl)
    const contentWidthPx = textEl.clientWidth || ctxRef.current.contentWidthPx

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
      const rowEl = root.querySelector<HTMLElement>(`[data-msg-chrome="${shape}"]`)
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

    // Structural rows tagged by kind (added in Task 6).
    const dateEl = root.querySelector<HTMLElement>('[data-row-kind="date"]')
    if (dateEl) chrome.date = Math.round(dateEl.getBoundingClientRect().height)
    const footEl = root.querySelector<HTMLElement>('[data-row-kind="footer"]')
    if (footEl) chrome.footer = Math.round(footEl.getBoundingClientRect().height)

    ctxRef.current = { fontSpec, contentWidthPx, lineBoxPx, chrome }
  }, [scrollRef])

  // Re-sample after layout settles on width changes (debounced signal) and on settings changes.
  useRemeasureOnWidthChange(sample)
  useEffect(() => {
    const id = requestAnimationFrame(() => sample())
    return () => cancelAnimationFrame(id)
  }, [sample, fontSize, densityMode])

  return ctxRef
}
