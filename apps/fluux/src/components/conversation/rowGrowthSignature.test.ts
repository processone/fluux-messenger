import { describe, it, expect } from 'vitest'
import { computeRowGrowthSignature, type RowGrowthMessage } from './rowGrowthSignature'

const text = (id: string, body = 'hello'): RowGrowthMessage => ({ id, body })

describe('computeRowGrowthSignature', () => {
  it('contributes nothing for plain text rows', () => {
    expect(computeRowGrowthSignature([text('a'), text('b'), text('c')])).toBe('')
  })

  it('is stable across re-renders of unchanged messages', () => {
    const messages = [text('a'), { ...text('b'), reactions: { '👍': ['x@y'] } }]
    expect(computeRowGrowthSignature(messages)).toBe(computeRowGrowthSignature([...messages]))
  })

  // Each of these lands on an ALREADY-rendered row without touching the message count or the
  // last-message id, so the signature is the only thing that can notice the height change.
  it.each([
    ['a link-preview fastening', { linkPreview: { url: 'https://example.com' } }],
    ['an attachment fastening', { attachment: { url: 'https://example.com/f.pdf' } }],
    ['a reaction', { reactions: { '👍': ['x@y'] } }],
    ['a retraction', { isRetracted: true }],
  ])('changes when %s lands on a resident row', (_label, update) => {
    const before = [text('a'), text('b')]
    const after = [text('a'), { ...text('b'), ...update }]
    expect(computeRowGrowthSignature(after)).not.toBe(computeRowGrowthSignature(before))
  })

  it('changes on a correction, and again on a second correction of different length', () => {
    const original = [text('a', 'hi')]
    const edited = [{ ...text('a', 'hi there'), isEdited: true }]
    const reEdited = [{ ...text('a', 'hi there, at greater length'), isEdited: true }]

    const sigs = [original, edited, reEdited].map(computeRowGrowthSignature)
    expect(new Set(sigs).size).toBe(3)
  })

  it('does not collide when adjacent rows carry different payloads', () => {
    const a = [{ ...text('a'), linkPreview: { url: 'u' } }, text('b')]
    const b = [text('a'), { ...text('b'), linkPreview: { url: 'u' } }]
    expect(computeRowGrowthSignature(a)).not.toBe(computeRowGrowthSignature(b))
  })
})
