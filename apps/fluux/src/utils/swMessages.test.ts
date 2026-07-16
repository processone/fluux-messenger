import { describe, it, expect } from 'vitest'
import { newMessagesText } from './swMessages'

describe('newMessagesText', () => {
  it('formats English plurals', () => {
    expect(newMessagesText('en', 2)).toBe('2 new messages')
    expect(newMessagesText('en-US', 5)).toBe('5 new messages')
  })

  it('formats French', () => {
    expect(newMessagesText('fr', 3)).toBe('3 nouveaux messages')
  })

  it('applies Slavic plural categories', () => {
    expect(newMessagesText('ru', 2)).toBe('2 новых сообщения') // few
    expect(newMessagesText('ru', 5)).toBe('5 новых сообщений') // many
    expect(newMessagesText('ru', 21)).toBe('21 новое сообщение') // one
  })

  it('matches base language for regional variants', () => {
    expect(newMessagesText('de-AT', 4)).toBe('4 neue Nachrichten')
  })

  it('handles zh-CN (no plural forms)', () => {
    expect(newMessagesText('zh-CN', 9)).toBe('9条新消息')
  })

  it('falls back to English for unknown locales', () => {
    expect(newMessagesText('tlh', 2)).toBe('2 new messages')
  })
})
