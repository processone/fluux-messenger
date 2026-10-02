import { afterEach, describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRowMetrics, ROW_METRICS_FALLBACK, MAX_CALIBRATIONS_PER_GEOMETRY } from './useRowMetrics'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** A plain-text header row shaped like MessageBubble's: sender header, body wrapper, text. */
function appendHeaderRow(
  root: HTMLElement,
  { width, height, quote = false }: { width: () => number; height: () => number; quote?: boolean },
): { row: HTMLElement; text: HTMLElement } {
  const row = root.appendChild(document.createElement('div'))
  row.dataset.msgChrome = 'header'
  row.appendChild(document.createElement('div')).dataset.msgSender = ''
  if (quote) row.appendChild(document.createElement('button')).className = 'reply-quote-card'
  const text = row.appendChild(document.createElement('div')).appendChild(document.createElement('div'))
  text.dataset.msgText = ''
  text.style.fontSize = '18px'
  text.style.lineHeight = '24px'
  text.textContent = 'Hello'
  Object.defineProperty(text, 'clientWidth', { get: width })
  row.getBoundingClientRect = () => new DOMRect(0, 0, width(), height())
  return { row, text }
}

describe('useRowMetrics', () => {
  it.each(['empty', 'attachment', 'retracted', 'encryption', 'system-notice'])(
    'keeps metrics uncalibrated for %s content until a real text row measures', kind => {
      const root = document.createElement('div')
      document.body.append(root)
      if (kind !== 'empty') {
        const row = root.appendChild(document.createElement('div'))
        row.textContent = kind
        if (kind !== 'system-notice') row.dataset.msgChrome = 'header'
      }
      const onCalibrated = vi.fn()
      const { result, unmount } = renderHook(() => useRowMetrics({ current: root }, onCalibrated))
      result.current.sample()
      expect(result.current.metricsRef.current).toBe(ROW_METRICS_FALLBACK)
      expect(onCalibrated).not.toHaveBeenCalled()

      const text = root.appendChild(document.createElement('div'))
      text.dataset.msgText = ''
      text.style.fontSize = '18px'
      text.style.lineHeight = '24px'
      result.current.sample()
      expect(onCalibrated).not.toHaveBeenCalled()
      Object.defineProperty(text, 'clientWidth', { value: 280 })
      result.current.sample()
      expect(result.current.metricsRef.current).toMatchObject({
        contentWidthPx: 280, lineBoxPx: 24,
        fontSpec: { fontSizePx: 18, lineHeightPx: 24 },
      })
      expect(onCalibrated).toHaveBeenCalledOnce()
      result.current.sample()
      expect(onCalibrated).toHaveBeenCalledOnce()
      unmount()
    },
  )

  it('notifies again when width, font or row chrome changes', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const root = document.createElement('div')
    let width = 280
    let height = 60
    const { text } = appendHeaderRow(root, { width: () => width, height: () => height })
    document.body.append(root)
    const onCalibrated = vi.fn()
    const { result, unmount } = renderHook(() => useRowMetrics({ current: root }, onCalibrated))
    result.current.sample()
    width = 200
    result.current.sample()
    expect(result.current.metricsRef.current.contentWidthPx).toBe(200)
    text.style.fontSize = '20px'
    text.style.lineHeight = '28px'
    result.current.sample()
    expect(result.current.metricsRef.current.fontSpec.fontSizePx).toBe(20)
    const chrome = result.current.metricsRef.current.chrome.header
    height += 10
    result.current.sample()
    expect(result.current.metricsRef.current.chrome.header).toBe(chrome + 10)
    expect(onCalibrated).toHaveBeenCalledTimes(4)
    unmount()
  })

  it('keeps header chrome stable when the first mounted header row alternates with a reply row', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const root = document.createElement('div')
    document.body.append(root)
    // One predicted line is 24px: a plain header row has 28px of chrome, the reply quote card
    // adds 54px more. Re-windowing decides which of the two rows is mounted first.
    const mount = (quoteFirst: boolean) => {
      root.replaceChildren()
      const quote = () => appendHeaderRow(root, { width: () => 280, height: () => 106, quote: true })
      const plain = () => appendHeaderRow(root, { width: () => 280, height: () => 52 })
      if (quoteFirst) { quote(); plain() } else { plain(); quote() }
    }
    const onCalibrated = vi.fn()
    const { result, unmount } = renderHook(() => useRowMetrics({ current: root }, onCalibrated))
    for (let i = 0; i < 8; i += 1) {
      mount(i % 2 === 0)
      result.current.sample()
      expect(result.current.metricsRef.current.chrome.header).toBe(28)
    }
    expect(onCalibrated).toHaveBeenCalledOnce()
    unmount()
  })

  it('stops notifying chrome-only changes after a bounded number of calibrations per geometry', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const root = document.createElement('div')
    document.body.append(root)
    let width = 280
    let height = 52
    appendHeaderRow(root, { width: () => width, height: () => height })
    const onCalibrated = vi.fn()
    const { result, unmount } = renderHook(() => useRowMetrics({ current: root }, onCalibrated))
    for (let i = 0; i < 10; i += 1) {
      height = 52 + (i % 2) * 54
      result.current.sample()
    }
    expect(onCalibrated).toHaveBeenCalledTimes(MAX_CALIBRATIONS_PER_GEOMETRY)
    // The latest sample still reaches the estimator without a notification.
    expect(result.current.metricsRef.current.chrome.header).toBe(height - 24)

    width = 200
    result.current.sample()
    expect(onCalibrated).toHaveBeenCalledTimes(MAX_CALIBRATIONS_PER_GEOMETRY + 1)
    unmount()
  })

  it('tells the listener which notification is the first calibration of the mount', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const root = document.createElement('div')
    document.body.append(root)
    let width = 280
    appendHeaderRow(root, { width: () => width, height: () => 52 })
    const onCalibrated = vi.fn()
    const { result, unmount } = renderHook(() => useRowMetrics({ current: root }, onCalibrated))
    result.current.sample()
    width = 200
    result.current.sample()
    expect(onCalibrated.mock.calls).toEqual([[true], [false]])
    unmount()
  })
})
