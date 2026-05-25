import { describe, it, expect, beforeEach } from 'vitest'
import { hasFastToken, getBareJid } from '@fluux/sdk'
import { clearAutoReconnectCredentials } from './clearLocalData'

const FAST_TOKEN_PREFIX = 'fluux:fast-token:'

function seedFastToken(bareJid: string): void {
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  localStorage.setItem(
    `${FAST_TOKEN_PREFIX}${bareJid}`,
    JSON.stringify({ mechanism: 'HT-SHA-256-NONE', token: 'tok', expiry })
  )
}

describe('clearAutoReconnectCredentials', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('removes the FAST token so post-logout auto-reconnect cannot re-authenticate', () => {
    const jid = 'user@example.com'
    seedFastToken(getBareJid(jid))
    expect(hasFastToken(jid)).toBe(true)

    clearAutoReconnectCredentials(`${jid}/resource`)

    expect(hasFastToken(jid)).toBe(false)
  })

  it('is a no-op when jid is null', () => {
    expect(() => clearAutoReconnectCredentials(null)).not.toThrow()
  })
})
