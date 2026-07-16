// Characterization ("golden") tests pinning TODAY's OpenPGP trust rendering
// across the three trust surfaces (SecurityTab detail panel, getGlance
// summary, and ChatHeader's own EncryptionIcon), so the Component-0
// TrustState migration (Tasks 2-4) can't silently change it. These assert on
// stable Lucide icon classes and `trustVisual` color tokens rather than
// translated text, EXCEPT where the app test i18n resource subset
// (apps/fluux/src/test-setup.ts) does supply a real translation for the key
// — in that case we assert the real rendered string (as
// SecurityGlanceCard.test.tsx already does), and fall back to the raw
// i18next key text only for keys that are intentionally left out of that
// test subset (e.g. `removeVerification`, `disableForContact`, and — for
// ChatHeader — the entire `chat.encryption.*` / `chat.verifyPeer.*`
// namespaces, which are not in the test-setup subset either).
//
// These tests MUST pass against the current, unmodified code — they are a
// regression net, not TDD-red-first.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import { ShieldCheck, Lock } from 'lucide-react'
import { SecurityTab } from '@/components/contact-profile/tabs/SecurityTab'
import { getGlance } from '@/components/contact-profile/cards/SecurityGlanceCard'
import { ChatHeader } from '@/components/ChatHeader'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import type { Contact } from '@fluux/sdk'

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

// ChatHeader render harness — mirrors ChatHeader.test.tsx's mocks (same
// hooks/store/Avatar isolation) but deliberately does NOT mock
// react-i18next, so `t()` runs through the real i18n instance from
// test-setup.ts, matching the harness the rest of this file already uses.
vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({ dragRegionProps: { 'data-tauri-drag-region': true } }),
  useAnchoredMenu: () => ({
    triggerRef: { current: null },
    menuRef: { current: null },
    position: { x: 0, y: 0 },
  }),
  useClickOutside: () => {},
}))
vi.mock('@/hooks/useHasHover', () => ({
  useHasHover: () => true,
  hasHover: () => true,
}))
const mockRosterContacts = new Map<string, Contact>()
vi.mock('@fluux/sdk/react', () => ({
  useRosterStore: (selector: (state: { contacts: Map<string, Contact> }) => unknown) =>
    selector({ contacts: mockRosterContacts }),
  useConnectionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useContactTime: () => null,
  useLastActivity: vi.fn(),
}))
vi.mock('@/components/Avatar', () => ({
  Avatar: ({ name }: { name: string }) => <div data-testid="avatar">{name}</div>,
}))
vi.mock('@/utils/statusText', () => ({
  getTranslatedStatusText: (contact: Contact) => contact.statusMessage ?? 'Online',
}))

function renderHeader(trust: 'verified' | 'unverified' | 'tofu-new') {
  return render(
    <ChatHeader
      name="Alice Smith"
      type="chat"
      jid="alice@example.com"
      encryptionState={{ kind: 'encrypted', fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555', trust }}
      onEncryptionClick={noop}
      onDisableEncryptionClick={noop}
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

  // --- ChatHeader's EncryptionIcon: a third, independent trust-rendering
  // path (own icon choice, own trustVisual() call, own tooltip/aria-label
  // strings) that the earlier SecurityTab/getGlance tests do not cover. ---

  it('ChatHeader: verified → ShieldCheck teal on the trigger button', () => {
    const { container } = renderHeader('verified')
    const shieldCheck = container.querySelector('button .lucide-shield-check')
    expect(shieldCheck).not.toBeNull()
    const button = shieldCheck!.closest('button')!
    expect(button.getAttribute('class')).toContain('text-fluux-encryption')
    // `chat.encryption.encryptedTo` is not in the test i18n resource subset
    // (only `contacts.encryption.*` is), so it falls back to the raw key —
    // that's the current, pinned behavior.
    expect(button.getAttribute('aria-label')).toBe('chat.encryption.encryptedTo')
  })

  it('ChatHeader: unverified → gray Shield (not ShieldCheck) on the trigger button', () => {
    const { container } = renderHeader('unverified')
    const shield = container.querySelector('button .lucide-shield')
    expect(shield).not.toBeNull()
    expect(container.querySelector('button .lucide-shield-check')).toBeNull()
    const button = shield!.closest('button')!
    expect(button.getAttribute('class')).toContain('text-fluux-muted')
    // `chat.verifyPeer.chipAriaLabel` is likewise absent from the test i18n
    // subset, so it too falls back to the raw key.
    expect(button.getAttribute('aria-label')).toBe('chat.verifyPeer.chipAriaLabel')
  })

  it('ChatHeader: tofu-new → same gray Shield + same aria-label as unverified (current quirk, no distinct chip)', () => {
    const { container } = renderHeader('tofu-new')
    const shield = container.querySelector('button .lucide-shield')
    expect(shield).not.toBeNull()
    expect(container.querySelector('button .lucide-shield-check')).toBeNull()
    const button = shield!.closest('button')!
    expect(button.getAttribute('class')).toContain('text-fluux-muted')
    expect(button.getAttribute('aria-label')).toBe('chat.verifyPeer.chipAriaLabel')
  })

  it('ChatHeader: unverified vs tofu-new hover tooltips differ (calm tofu-new copy has a real default string; unverified falls back to raw key)', async () => {
    vi.useFakeTimers()
    try {
      const unverified = renderHeader('unverified')
      const unverifiedButton = unverified.container.querySelector('button')!
      fireEvent.mouseEnter(unverifiedButton)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700)
      })
      // `chat.encryption.openpgpTooltip` has no defaultValue in ChatHeader.tsx
      // and isn't in the test i18n subset, so it falls back to the raw key.
      expect(document.body.textContent).toContain('chat.encryption.openpgpTooltip')
      unverified.unmount()

      const tofuNew = renderHeader('tofu-new')
      const tofuButton = tofuNew.container.querySelector('button')!
      fireEvent.mouseEnter(tofuButton)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700)
      })
      // `chat.encryption.tofuNewTooltip` DOES carry a defaultValue in
      // ChatHeader.tsx, so react-i18next renders that literal string even
      // though the key itself isn't in the test i18n subset.
      expect(document.body.textContent).toContain('New contact — verify fingerprint for full trust')
      expect(document.body.textContent).not.toContain('chat.encryption.tofuNewTooltip')
      tofuNew.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
