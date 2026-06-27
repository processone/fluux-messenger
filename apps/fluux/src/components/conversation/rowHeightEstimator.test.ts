import { describe, it, expect } from 'vitest'
import { estimateRowHeight, type RowEstimatorContext } from './rowHeightEstimator'
import type { RenderItem } from './messageListItems'

interface Msg { id: string; body: string; reactions?: Record<string, string[]>; attachment?: unknown; isRetracted?: boolean }

const CTX: RowEstimatorContext = {
  fontSpec: { fontFamily: 'Inter', fontSizePx: 16, fontWeight: 400, fontStyle: 'normal', lineHeightPx: 22, letterSpacingPx: 0, whiteSpace: 'pre-wrap' },
  contentWidthPx: 560,
  lineBoxPx: 22,
  chrome: { header: 40, continuation: 6, reactionsRow: 28, newMarker: 48, date: 48, loadEarlierHeader: 52, footer: 40 },
}

const msgItem = (m: Msg, over: Partial<Extract<RenderItem<Msg>, { kind: 'message' }>> = {}): RenderItem<Msg> => ({
  kind: 'message', key: m.id, message: m, showAvatar: true, isFirstNew: false, indexInGroup: 0, groupMessages: [m], ...over,
})

describe('estimateRowHeight (structural rows + chrome, no canvas needed)', () => {
  it('date row = chrome.date', () => {
    expect(estimateRowHeight<Msg>({ kind: 'date', key: 'd', date: '2026-06-27' }, CTX)).toBe(48)
  })
  it('header row = chrome.loadEarlierHeader', () => {
    expect(estimateRowHeight<Msg>({ kind: 'header', key: '__header' }, CTX)).toBe(52)
  })
  it('footer row = chrome.footer', () => {
    expect(estimateRowHeight<Msg>({ kind: 'footer', key: '__footer' }, CTX)).toBe(40)
  })
  it('media message uses reserved media space + header chrome', () => {
    const h = estimateRowHeight<Msg>(msgItem({ id: '1', body: '', attachment: { url: 'x' } }), CTX)
    expect(h).toBe(260 + 40) // RESERVED_MEDIA_PX + chrome.header
  })
  it('empty/retracted message = one line box + continuation chrome when not first in group', () => {
    const h = estimateRowHeight<Msg>(msgItem({ id: '1', body: '', isRetracted: true }, { showAvatar: false }), CTX)
    expect(h).toBe(22 + 6) // one lineBox + chrome.continuation
  })
  it('a first-new text message adds the new-message marker', () => {
    const withMarker = estimateRowHeight<Msg>(msgItem({ id: '1', body: '' }, { isFirstNew: true, showAvatar: false }), CTX)
    const without = estimateRowHeight<Msg>(msgItem({ id: '1', body: '' }, { isFirstNew: false, showAvatar: false }), CTX)
    expect(withMarker - without).toBe(48) // chrome.newMarker
  })
  it('reactions add a reactions row', () => {
    const withR = estimateRowHeight<Msg>(msgItem({ id: '1', body: '', reactions: { 'a': ['x'] } }, { showAvatar: false }), CTX)
    const withoutR = estimateRowHeight<Msg>(msgItem({ id: '1', body: '' }, { showAvatar: false }), CTX)
    expect(withR - withoutR).toBe(28) // chrome.reactionsRow
  })
})
