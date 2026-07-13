// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { pickWidthSampleEl, pickChromeSampleEl } from './useRowMetrics'

function el(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

function setWidth(e: Element, w: number): void {
  Object.defineProperty(e, 'clientWidth', { get: () => w, configurable: true })
}

describe('pickWidthSampleEl', () => {
  it('prefers a text element outside own (hug-width) bubbles', () => {
    // Own bubbles are w-fit: their [data-msg-text] clientWidth is the hugged TEXT width, not
    // the available content width — sampling one poisons the width bucket for the whole
    // conversation (bucket churns with whichever row happens to be first).
    const root = el(`
      <div data-msg-chrome="cont" data-msg-own><div data-msg-text>ok</div></div>
      <div data-msg-chrome="header"><div data-msg-text>a longer peer message</div></div>
    `)
    const own = root.querySelector('[data-msg-own] [data-msg-text]')!
    const peer = root.querySelector('[data-msg-chrome="header"] [data-msg-text]')!
    setWidth(own, 38)
    setWidth(peer, 890)
    expect(pickWidthSampleEl(root)).toBe(peer)
  })

  it('falls back to the widest own text element when only own rows are mounted', () => {
    const root = el(`
      <div data-msg-chrome="cont" data-msg-own><div data-msg-text>ok</div></div>
      <div data-msg-chrome="cont" data-msg-own><div data-msg-text>a much longer own message</div></div>
    `)
    const [short, long] = Array.from(root.querySelectorAll('[data-msg-text]'))
    setWidth(short, 38)
    setWidth(long, 542)
    expect(pickWidthSampleEl(root)).toBe(long)
  })

  it('returns null when nothing is mounted', () => {
    expect(pickWidthSampleEl(el(''))).toBeNull()
  })
})

describe('pickChromeSampleEl', () => {
  it('skips rows containing block content the text predictor cannot model', () => {
    // A quote/code/media row's outer height wildly exceeds the predicted plain-text height of
    // its textContent, so chrome = outer - predicted comes out as garbage (observed: a
    // continuation chrome of 369px vs the real ~6px), poisoning every unseeded estimate.
    const root = el(`
      <div data-msg-chrome="cont"><blockquote>quoted wall</blockquote><div data-msg-text>reply</div></div>
      <div data-msg-chrome="cont"><div data-msg-text>plain continuation</div></div>
    `)
    const clean = root.querySelectorAll('[data-msg-chrome="cont"]')[1]
    expect(pickChromeSampleEl(root, 'cont')).toBe(clean)
  })

  it('skips own hug-width rows (their text box does not span the content width)', () => {
    const root = el(`
      <div data-msg-chrome="header" data-msg-own><div data-msg-text>own</div></div>
      <div data-msg-chrome="header"><div data-msg-text>peer</div></div>
    `)
    const peer = root.querySelectorAll('[data-msg-chrome="header"]')[1]
    expect(pickChromeSampleEl(root, 'header')).toBe(peer)
  })

  it('returns null when no clean row of the requested shape exists', () => {
    const root = el(`
      <div data-msg-chrome="cont"><pre>code</pre><div data-msg-text>x</div></div>
    `)
    expect(pickChromeSampleEl(root, 'cont')).toBeNull()
    expect(pickChromeSampleEl(root, 'header')).toBeNull()
  })
})
