// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { pickWidthSampleEl, pickChromeSampleEl, realContentWidthPx } from './useRowMetrics'

function el(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

function setWidth(e: Element, w: number): void {
  Object.defineProperty(e, 'clientWidth', { get: () => w, configurable: true })
}

describe('pickWidthSampleEl', () => {
  it('skips whisper cards, whose inset narrows their text box', () => {
    const root = el(`
      <div data-msg-chrome="cont" data-msg-whisper><div data-msg-text>a whisper</div></div>
      <div data-msg-chrome="header"><div data-msg-text>a peer message</div></div>
    `)
    const peer = root.querySelector('[data-msg-chrome="header"] [data-msg-text]')!
    expect(pickWidthSampleEl(root)).toBe(peer)
  })

  it('returns null when only whisper cards are mounted', () => {
    expect(pickWidthSampleEl(el(`
      <div data-msg-chrome="cont" data-msg-whisper><div data-msg-text>a whisper</div></div>
    `))).toBeNull()
  })

  it('returns null when nothing is mounted', () => {
    expect(pickWidthSampleEl(el(''))).toBeNull()
  })
})

describe('realContentWidthPx', () => {
  // The height cache's width tag follows this value. Widths are the demo app's at 1280px wide
  // in Chromium.
  it('reads the content column a row sits in', () => {
    const root = el(`
      <div data-msg-column><div data-msg-chrome="cont"><div data-msg-text>a peer message</div></div></div>
    `)
    setWidth(root.querySelector('[data-msg-column]')!, 888)
    const text = root.querySelector<HTMLElement>('[data-msg-text]')!
    setWidth(text, 880)
    expect(realContentWidthPx(text)).toBe(888)
  })

  it('outside a content column, trusts the text box', () => {
    const root = el(`<div data-msg-chrome="cont"><div data-msg-text>a peer message</div></div>`)
    const text = root.querySelector<HTMLElement>('[data-msg-text]')!
    setWidth(text, 888)
    expect(realContentWidthPx(text)).toBe(888)
  })
})

// Mirrors MessageBubble: the chrome row holds the sender header (header rows only), then the
// collapsible body, then whatever decorates the message.
const SENDER = '<div data-msg-sender>Alice 14:30</div>'
function row(shape: 'header' | 'cont', body: string, opts: { whisper?: boolean; before?: string; after?: string } = {}): string {
  const header = shape === 'header' ? SENDER : ''
  return `<div data-msg-chrome="${shape}"${opts.whisper ? ' data-msg-whisper' : ''}>${header}${opts.before ?? ''}<div>${body}</div>${opts.after ?? ''}</div>`
}
const TEXT = '<div data-msg-text>plain text</div>'

describe('pickChromeSampleEl', () => {
  it('skips rows containing block content the text predictor cannot model', () => {
    // A quote/code/media row's outer height wildly exceeds the predicted plain-text height of
    // its textContent, so chrome = outer - predicted comes out as garbage (observed: a
    // continuation chrome of 369px vs the real ~6px), poisoning every unseeded estimate.
    const root = el(`
      ${row('cont', '<div data-msg-text><blockquote>quoted wall</blockquote>reply</div>')}
      ${row('cont', TEXT)}
    `)
    const clean = root.querySelectorAll('[data-msg-chrome="cont"]')[1]
    expect(pickChromeSampleEl(root, 'cont')).toBe(clean)
  })

  it('skips whisper cards (their inset and padding are not ordinary chrome)', () => {
    const root = el(`
      ${row('header', TEXT, { whisper: true })}
      ${row('header', TEXT)}
    `)
    const peer = root.querySelectorAll('[data-msg-chrome="header"]')[1]
    expect(pickChromeSampleEl(root, 'header')).toBe(peer)
  })

  it.each([
    ['a reply quote card', { before: '<button class="reply-quote-card">Bob: earlier</button>' }],
    ['a reactions strip', { after: '<div><button>👍 1</button></div>' }],
    ['a delivery error', { after: '<div>chat.deliveryFailed</div>' }],
  ])('skips a row carrying %s next to its text', (_kind, decoration) => {
    // The decoration adds height the text predictor cannot see: sampling it makes the header
    // chrome jump by the decoration's height whenever it is the first mounted header row.
    const root = el(`
      ${row('header', TEXT, decoration)}
      ${row('header', TEXT)}
    `)
    const plain = root.querySelectorAll('[data-msg-chrome="header"]')[1]
    expect(pickChromeSampleEl(root, 'header')).toBe(plain)
  })

  it.each([
    ['an attachment', `${TEXT}<div class="attachment-card">file.pdf</div>`],
    ['a link preview', `${TEXT}<a class="link-preview">preview</a>`],
    ['a poll', `${TEXT}<div role="group">poll</div>`],
    ['a collapsed long body', `<div class="max-h-[500px]">${TEXT}<div class="fade"></div></div><button>chat.showMore</button>`],
  ])('skips a row whose body holds %s besides the text', (_kind, body) => {
    const root = el(`
      ${row('cont', body)}
      ${row('cont', TEXT)}
    `)
    const plain = root.querySelectorAll('[data-msg-chrome="cont"]')[1]
    expect(pickChromeSampleEl(root, 'cont')).toBe(plain)
  })

  it('samples header chrome only from rows that show the sender header', () => {
    // A /me action opens a group without the sender header, so its chrome is shorter.
    const root = el(`
      <div data-msg-chrome="header"><div>${TEXT}</div></div>
      ${row('header', TEXT)}
    `)
    const withSender = root.querySelectorAll('[data-msg-chrome="header"]')[1]
    expect(pickChromeSampleEl(root, 'header')).toBe(withSender)
  })

  it('returns null when no clean row of the requested shape exists', () => {
    const root = el(`
      ${row('cont', '<div data-msg-text><pre>code</pre>x</div>')}
    `)
    expect(pickChromeSampleEl(root, 'cont')).toBeNull()
    expect(pickChromeSampleEl(root, 'header')).toBeNull()
  })
})
