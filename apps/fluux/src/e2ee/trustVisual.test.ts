import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { trustVisual } from './trustVisual'

describe('trustVisual', () => {
  it('maps verified to the teal encryption token', () => {
    expect(trustVisual('verified')).toEqual({ colorClass: 'text-fluux-encryption', tone: 'verified' })
  })
  it('maps trusted (tofu) to calm gray', () => {
    expect(trustVisual('trusted')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('CALMS keyLocked to gray (own un-entered passphrase is not a threat)', () => {
    expect(trustVisual('keyLocked')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
  it('maps decryptFailed and keyChanged to the warning token', () => {
    expect(trustVisual('decryptFailed').colorClass).toBe('text-fluux-yellow')
    expect(trustVisual('decryptFailed').tone).toBe('warning')
    expect(trustVisual('keyChanged')).toEqual({ colorClass: 'text-fluux-yellow', tone: 'warning' })
  })
  it('maps rejected to the error token', () => {
    expect(trustVisual('rejected')).toEqual({ colorClass: 'text-fluux-error', tone: 'danger' })
  })
  it('maps plaintext and checking to calm gray', () => {
    expect(trustVisual('plaintext')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
    expect(trustVisual('checking')).toEqual({ colorClass: 'text-fluux-muted', tone: 'calm' })
  })
})

// Static guard: the trust-lock surfaces must route every trust color through
// trustVisual (the tokens), never a bare red/yellow/green palette class. Read
// the sources from process.cwd() (the app runs vitest from apps/fluux; import.meta.url
// is not a file:// path under vitest, so the cwd-relative path is the reliable one).
describe('lock surfaces use trustVisual tokens (no bare trust palette)', () => {
  const lockSurfaces = [
    'src/components/conversation/MessageBubble.tsx',
    'src/components/ChatHeader.tsx',
    'src/components/contact-profile/tabs/SecurityTab.tsx',
  ]
  for (const file of lockSurfaces) {
    it(`${file} has no bare red/yellow/green trust palette class`, () => {
      const src = readFileSync(join(process.cwd(), file), 'utf-8')
      expect(src.match(/text-(red|yellow|green)-[0-9]{3}/g)).toBeNull()
    })
  }
})
