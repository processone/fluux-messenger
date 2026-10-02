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

// Mirrors MessageBubble: the chrome row holds the sender header (header rows only), then the
// collapsible body, then whatever decorates the message.
const SENDER = '<div data-msg-sender>Alice 14:30</div>'
function row(shape: 'header' | 'cont', body: string, opts: { own?: boolean; before?: string; after?: string } = {}): string {
  const header = shape === 'header' ? SENDER : ''
  return `<div data-msg-chrome="${shape}"${opts.own ? ' data-msg-own' : ''}>${header}${opts.before ?? ''}<div>${body}</div>${opts.after ?? ''}</div>`
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

  it('skips own hug-width rows (their text box does not span the content width)', () => {
    const root = el(`
      ${row('header', TEXT, { own: true })}
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
