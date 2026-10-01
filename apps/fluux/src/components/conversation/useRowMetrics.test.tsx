import { afterEach, describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRowMetrics, ROW_METRICS_FALLBACK } from './useRowMetrics'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

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
    const row = root.appendChild(document.createElement('div'))
    row.dataset.msgChrome = 'header'
    const text = row.appendChild(document.createElement('div'))
    text.dataset.msgText = ''
    text.style.fontSize = '18px'
    text.style.lineHeight = '24px'
    text.textContent = 'Hello'
    let width = 280
    let height = 60
    Object.defineProperty(text, 'clientWidth', { get: () => width })
    row.getBoundingClientRect = () => new DOMRect(0, 0, width, height)
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
})
