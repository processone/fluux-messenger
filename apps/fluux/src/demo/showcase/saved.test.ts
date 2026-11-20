import { describe, it, expect, beforeEach } from 'vitest'
import { savedStore } from '@fluux/sdk'
import { buildShowcaseData } from './index'
import { seedShowcaseSaved } from './saved'

// FLM-400: the showcase scene opens with five saved messages that read well in a picture
// (their own text, no deleted, unverified or placeholder rows).
describe('seedShowcaseSaved', () => {
  beforeEach(() => savedStore.getState().reset())

  it('saves the five curated messages, newest save first, each with its own text', () => {
    seedShowcaseSaved(buildShowcaseData())
    const entries = Object.values(savedStore.getState().entries).sort((a, b) => b.savedAt - a.savedAt)
    expect(entries.map(e => e.text.slice(0, 13))).toEqual([
      'Venue confirm', 'Door code is ', 'Press kit is ', 'Livestream is', 'Badges are pr',
    ])
    expect(entries.every(e => !e.deleted && !e.unverified && e.text.length > 0)).toBe(true)
    expect(entries.filter(e => e.type === 'groupchat')).toHaveLength(2)
    expect(entries.find(e => e.text.startsWith('Door code'))?.encrypted).toBe(true)
  })
})
