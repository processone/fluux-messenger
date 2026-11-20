import { describe, it, expect, beforeEach } from 'vitest'
import { savedStore } from '@fluux/sdk'
import { buildShowcaseData } from './index'
import { seedShowcaseSaved } from './saved'

// The showcase scene opens with five saved messages that read well in a picture
// (their own text, no deleted, unverified or placeholder rows).
describe('seedShowcaseSaved', () => {
  beforeEach(() => savedStore.getState().reset())

  it('saves the five curated messages, newest save first, each with its own text', () => {
    seedShowcaseSaved(buildShowcaseData())
    const entries = Object.values(savedStore.getState().entries).sort((a, b) => b.savedAt - a.savedAt)
    expect(entries.map(e => e.messageId)).toEqual([
      'showcase-emma-1', 'showcase-ava-4', 'showcase-liam-3', 'showcase-launch-3', 'showcase-design-1',
    ])
    expect(entries.every(e => !e.deleted && !e.unverified && e.text.length > 0)).toBe(true)
    expect(entries.filter(e => e.type === 'groupchat')).toHaveLength(2)
    expect(entries.find(e => e.messageId === 'showcase-ava-4')?.encrypted).toBe(true)
  })
})
