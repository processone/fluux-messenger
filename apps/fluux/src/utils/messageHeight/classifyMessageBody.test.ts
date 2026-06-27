import { describe, it, expect } from 'vitest'
import { classifyMessageBody } from './classifyMessageBody'

describe('classifyMessageBody', () => {
  it('classifies a plain text message as text', () => {
    expect(classifyMessageBody({ body: 'hello there' })).toBe('text')
  })
  it('classifies a fenced code block as code', () => {
    expect(classifyMessageBody({ body: '```\nconst x = 1\n```' })).toBe('code')
  })
  it('does NOT classify inline code as code', () => {
    expect(classifyMessageBody({ body: 'use `npm run dev` to start' })).toBe('text')
  })
  it('classifies an attachment as media regardless of body', () => {
    expect(classifyMessageBody({ body: '', attachment: { url: 'x' } })).toBe('media')
  })
  it('classifies a link preview as media', () => {
    expect(classifyMessageBody({ body: 'see https://x', linkPreview: { title: 'X' } })).toBe('media')
  })
  it('classifies a poll as media', () => {
    expect(classifyMessageBody({ body: '', poll: { question: 'Q' } })).toBe('media')
  })
  it('classifies an empty/retracted body as empty', () => {
    expect(classifyMessageBody({ body: '' })).toBe('empty')
    expect(classifyMessageBody({ body: 'gone', isRetracted: true })).toBe('empty')
  })
})
