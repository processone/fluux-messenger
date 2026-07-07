import { describe, it, expect } from 'vitest'
import { parseSlashInput } from './parseSlashInput'

describe('parseSlashInput', () => {
  it('treats plain text as a message', () => {
    expect(parseSlashInput('hello world')).toEqual({ kind: 'message' })
  })
  it('treats // as a literal with one slash stripped', () => {
    expect(parseSlashInput('//not a command')).toEqual({ kind: 'literal', text: '/not a command' })
  })
  it('treats /me <action> as passthrough (verbatim)', () => {
    expect(parseSlashInput('/me waves hello')).toEqual({ kind: 'passthrough', text: '/me waves hello' })
  })
  it('treats /me without a trailing space as a command (no-op)', () => {
    expect(parseSlashInput('/me')).toEqual({ kind: 'command', name: 'me', args: '' })
  })
  it('treats /say <text> as a literal of the remainder', () => {
    expect(parseSlashInput('/say /me is literal')).toEqual({ kind: 'literal', text: '/me is literal' })
  })
  it('treats bare /say as an empty literal', () => {
    expect(parseSlashInput('/say')).toEqual({ kind: 'literal', text: '' })
  })
  it('parses a command name and args, lowercasing the name', () => {
    expect(parseSlashInput('/Nick Bob The Builder')).toEqual({ kind: 'command', name: 'nick', args: 'Bob The Builder' })
  })
  it('parses a command with no args', () => {
    expect(parseSlashInput('/part')).toEqual({ kind: 'command', name: 'part', args: '' })
  })
})
