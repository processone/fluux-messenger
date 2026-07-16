// Characterization ("golden") tests pinning TODAY's OpenPGP trust rendering
// across the three trust surfaces (SecurityTab detail panel + getGlance
// summary), so the Component-0 TrustState migration (Tasks 2-4) can't
// silently change it. These assert on stable Lucide icon classes and
// `trustVisual` color tokens rather than translated text, EXCEPT where the
// app test i18n resource subset (apps/fluux/src/test-setup.ts) does supply a
// real translation for the key — in that case we assert the real rendered
// string (as SecurityGlanceCard.test.tsx already does), and fall back to the
// raw i18next key text only for keys that are intentionally left out of that
// test subset (e.g. `removeVerification`, `disableForContact`).
//
// These tests MUST pass against the current, unmodified code — they are a
// regression net, not TDD-red-first.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ShieldCheck, Lock } from 'lucide-react'
import { SecurityTab } from '@/components/contact-profile/tabs/SecurityTab'
import { getGlance } from '@/components/contact-profile/cards/SecurityGlanceCard'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

const noop = () => {}
const identity = (k: string) => k

function renderTab(state: ConversationEncryptionState) {
  return render(
    <SecurityTab
      state={state}
      onVerify={noop}
      onRequestRevoke={noop}
      onDisableEncryption={noop}
      onEnableEncryption={noop}
    />,
  )
}

describe('OpenPGP trust rendering (characterization — must not change under Component-0)', () => {
  it('SecurityTab: verified → ShieldCheck teal + Remove-verification button, no Verify button', () => {
    const { container } = renderTab({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'verified' })
    const shieldCheck = container.querySelector('.lucide-shield-check')
    expect(shieldCheck).not.toBeNull()
    expect(shieldCheck!.getAttribute('class')).toContain('text-fluux-encryption')
    // `removeVerification` is not in the test i18n resource subset, so
    // react-i18next falls back to rendering the raw key text — that's the
    // current, pinned behavior (see test-setup.ts).
    expect(container.textContent).toContain('contacts.encryption.removeVerification')
    // `verifyButton` IS in the test i18n subset (translates to "Verify
    // fingerprint"), but the verified state must not render the button at
    // all — assert on the real translated string.
    expect(container.textContent).not.toContain('Verify fingerprint')
  })

  it('SecurityTab: unverified → gray Shield + Verify button', () => {
    const { container } = renderTab({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'unverified' })
    // The heading icon is a plain Shield (not ShieldCheck), gray.
    const plainShield = container.querySelector('.lucide-shield')
    expect(plainShield).not.toBeNull()
    expect(plainShield!.getAttribute('class')).toContain('text-fluux-muted')
    expect(container.textContent).toContain('Verify fingerprint')
    expect(container.textContent).not.toContain('contacts.encryption.removeVerification')
  })

  it('SecurityTab: tofu-new → gray Shield, neither Verify nor Remove button (current quirk)', () => {
    const { container } = renderTab({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'tofu-new' })
    expect(container.querySelector('.lucide-shield')).not.toBeNull()
    expect(container.textContent).not.toContain('Verify fingerprint')
    expect(container.textContent).not.toContain('contacts.encryption.removeVerification')
  })

  it('getGlance: verified → ShieldCheck/glanceVerified/success', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'verified' }, identity)
    expect(g).toEqual({ icon: ShieldCheck, label: 'contacts.encryption.glanceVerified', tone: 'success' })
  })

  it('getGlance: unverified → Lock/glanceEncrypted/neutral', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'unverified' }, identity)
    expect(g).toEqual({ icon: Lock, label: 'contacts.encryption.glanceEncrypted', tone: 'neutral' })
  })

  it('getGlance: tofu-new → Lock/glanceEncrypted/neutral (not verified)', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'tofu-new' }, identity)
    expect(g).toEqual({ icon: Lock, label: 'contacts.encryption.glanceEncrypted', tone: 'neutral' })
  })
})
