import { describe, it, expect, beforeEach } from 'vitest'
import { messageRequestPreviewStore } from './messageRequestPreviewStore'

describe('messageRequestPreviewStore', () => {
  beforeEach(() => messageRequestPreviewStore.getState().setPreviewJid(null))

  it('sets and reads the previewed jid', () => {
    messageRequestPreviewStore.getState().setPreviewJid('stranger@example.com')
    expect(messageRequestPreviewStore.getState().previewJid).toBe('stranger@example.com')
  })

  it('clears the preview', () => {
    messageRequestPreviewStore.getState().setPreviewJid('stranger@example.com')
    messageRequestPreviewStore.getState().setPreviewJid(null)
    expect(messageRequestPreviewStore.getState().previewJid).toBeNull()
  })
})
