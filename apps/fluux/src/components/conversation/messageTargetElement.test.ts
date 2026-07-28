import { describe, expect, it } from 'vitest'
import { findMessageTargetElement } from './messageTargetElement'

describe('findMessageTargetElement', () => {
  it('resolves local, stanza, and origin ids within the supplied list only', () => {
    const outside = document.createElement('div')
    outside.innerHTML = '<div data-message-id="shared"></div>'
    document.body.append(outside)

    const root = document.createElement('div')
    root.innerHTML = [
      '<div data-message-id="local/id" data-stanza-id="stanza+id" data-origin-id="origin=id"></div>',
      '<div data-message-id="shared"></div>',
    ].join('')

    expect(findMessageTargetElement(root, 'local/id')?.dataset.messageId).toBe('local/id')
    expect(findMessageTargetElement(root, 'stanza+id')?.dataset.messageId).toBe('local/id')
    expect(findMessageTargetElement(root, 'origin=id')?.dataset.messageId).toBe('local/id')
    expect(findMessageTargetElement(root, 'shared')?.parentElement).toBe(root)

    outside.remove()
  })

  it('prefers the local id tier when aliases collide', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<div data-stanza-id="same" data-message-id="stanza-row"></div>',
      '<div data-message-id="same"></div>',
      '<div data-origin-id="same" data-message-id="origin-row"></div>',
    ].join('')

    expect(findMessageTargetElement(root, 'same')?.dataset.messageId).toBe('same')
  })
})
