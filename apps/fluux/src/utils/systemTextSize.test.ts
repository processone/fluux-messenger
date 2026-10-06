/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { measureSystemBodySize, rootFontSize } from './systemTextSize'

describe('rootFontSize', () => {
  it('keeps a percentage of the browser default when the OS size is unknown', () => {
    expect(rootFontSize(100, null)).toBe('100%')
    expect(rootFontSize(125, null)).toBe('125%')
  })

  it('scales the OS body size by the app font size', () => {
    expect(rootFontSize(100, 17)).toBe('17px')
    expect(rootFontSize(125, 17)).toBe('21.25px')
    expect(rootFontSize(90, 23)).toBe('20.7px')
  })
})

describe('measureSystemBodySize', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null where the webview does not know the system font', () => {
    expect(measureSystemBodySize()).toBeNull()
    expect(document.body.children).toHaveLength(0)
  })

  it('reads the computed size of the system body font and removes the probe', () => {
    const createElement = document.createElement.bind(document)
    let font = ''
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = createElement(tag)
      // jsdom drops system font keywords; WebKit keeps them.
      Object.defineProperty(element.style, 'font', { get: () => font, set: (v: string) => { font = v } })
      return element
    })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ fontSize: '23px' } as CSSStyleDeclaration)

    expect(measureSystemBodySize()).toBe(23)
    expect(font).toBe('-apple-system-body')
    expect(document.body.children).toHaveLength(0)
  })
})
