/**
 * Unit tests for the secret-key backup fingerprint marker.
 *
 * The marker is persisted in localStorage (not in PluginStorage, which
 * is currently in-memory) so it survives an app restart — without
 * persistence, the "are local and server in sync?" UX regresses to
 * "always show the backup button" after every restart.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  readBackedUpFingerprint,
  writeBackedUpFingerprint,
  clearBackedUpFingerprint,
} from './backupMarker'

const JID_A = 'alice@example.com'
const JID_B = 'bob@example.com'
const FP_V6 = 'A'.repeat(64)

describe('backupMarker', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when no marker has been written', () => {
    expect(readBackedUpFingerprint(JID_A)).toBeNull()
  })

  it('round-trips a written fingerprint', () => {
    writeBackedUpFingerprint(JID_A, FP_V6)
    expect(readBackedUpFingerprint(JID_A)).toBe(FP_V6)
  })

  it('overwrites the marker on subsequent writes (e.g. key regenerate + backup)', () => {
    writeBackedUpFingerprint(JID_A, FP_V6)
    const newer = 'B'.repeat(64)
    writeBackedUpFingerprint(JID_A, newer)
    expect(readBackedUpFingerprint(JID_A)).toBe(newer)
  })

  it('clears the marker', () => {
    writeBackedUpFingerprint(JID_A, FP_V6)
    clearBackedUpFingerprint(JID_A)
    expect(readBackedUpFingerprint(JID_A)).toBeNull()
  })

  it('keeps markers for different accounts isolated', () => {
    // Multi-account users must not see device A's backup state bleed
    // into the UI for device B.
    const fpA = 'A'.repeat(64)
    const fpB = 'B'.repeat(64)
    writeBackedUpFingerprint(JID_A, fpA)
    writeBackedUpFingerprint(JID_B, fpB)
    expect(readBackedUpFingerprint(JID_A)).toBe(fpA)
    expect(readBackedUpFingerprint(JID_B)).toBe(fpB)
    clearBackedUpFingerprint(JID_A)
    expect(readBackedUpFingerprint(JID_A)).toBeNull()
    expect(readBackedUpFingerprint(JID_B)).toBe(fpB)
  })

  it('silently no-ops when the bare JID is empty', () => {
    // Defensive: the plugin passes `ctx.account.jid` which is typed
    // `BareJID` but at init time could still be unset in pathological
    // edge cases. A write with an empty key would pollute storage.
    writeBackedUpFingerprint('', FP_V6)
    expect(readBackedUpFingerprint('')).toBeNull()
    expect(readBackedUpFingerprint(JID_A)).toBeNull()
  })

  it('silently no-ops when the fingerprint is empty', () => {
    // A plugin bug that tried to record an empty marker must not
    // overwrite a legitimate earlier value.
    writeBackedUpFingerprint(JID_A, FP_V6)
    writeBackedUpFingerprint(JID_A, '')
    expect(readBackedUpFingerprint(JID_A)).toBe(FP_V6)
  })
})
