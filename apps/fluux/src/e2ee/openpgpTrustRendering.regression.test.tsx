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
import { render, fireEvent, act, waitFor } from '@testing-library/react'
import { ShieldCheck, Lock } from 'lucide-react'
import type { PeerIdentity } from '@fluux/sdk'
import { SecurityTab } from '@/components/contact-profile/tabs/SecurityTab'
import { getGlance } from '@/components/contact-profile/cards/SecurityGlanceCard'
import { ChatHeader } from '@/components/ChatHeader'
import type { Contact } from '@fluux/sdk'

const noop = () => {}
const identity = (k: string) => k

function makeOpenpgp(list: PeerIdentity[]) {
  return {
    listPeerIdentities: vi.fn().mockResolvedValue(list),
    onVerifyDevice: vi.fn(),
    onRevokeDevice: vi.fn().mockResolvedValue(undefined),
    rowLabel: () => 'OpenPGP key',
  }
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

function renderHeader(trust: 'verified' | 'tofu', firstSeen?: boolean) {
  return render(
    <ChatHeader
      name="Alice Smith"
      type="chat"
      jid="alice@example.com"
      encryptionState={{
        kind: 'encrypted',
        fingerprint: 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555',
        trust,
        ...(firstSeen ? { firstSeen: true } : {}),
      }}
      onEncryptionClick={noop}
      onDisableEncryptionClick={noop}
    />,
  )
}

describe('OpenPGP trust rendering (characterization — must not change under Component-0)', () => {
  it('SecurityTab (OpenPGP identity): verified → ShieldCheck teal badge + revoke', async () => {
    const identities = makeOpenpgp([{ id: 'ABCD1234', fingerprint: 'ABCD1234', trust: 'verified' }])
    const { container } = render(
      <SecurityTab
        state={{ kind: 'encrypted', protocolId: 'openpgp', fingerprint: 'ABCD1234', trust: 'verified' }}
        peerJid="alice@x"
        identities={identities}
        onVerify={noop} onRequestRevoke={noop} onDisableEncryption={noop} onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(identities.listPeerIdentities).toHaveBeenCalledWith('alice@x'))
    const badge = container.querySelector('span.inline-flex') as HTMLElement
    expect(badge.className).toContain('text-fluux-encryption')
    expect(container.querySelector('.lucide-shield-check')).not.toBeNull()
    expect(container.querySelector('[data-testid="omemo-revoke-ABCD1234"]')).not.toBeNull()
  })

  it('SecurityTab (OpenPGP identity): tofu → plain Shield + verify button', async () => {
    const identities = makeOpenpgp([{ id: 'ABCD1234', fingerprint: 'ABCD1234', trust: 'tofu' }])
    const { container } = render(
      <SecurityTab
        state={{ kind: 'encrypted', protocolId: 'openpgp', fingerprint: 'ABCD1234', trust: 'tofu' }}
        peerJid="alice@x"
        identities={identities}
        onVerify={noop} onRequestRevoke={noop} onDisableEncryption={noop} onEnableEncryption={noop}
      />,
    )
    await waitFor(() => expect(identities.listPeerIdentities).toHaveBeenCalledWith('alice@x'))
    const badge = container.querySelector('span.inline-flex') as HTMLElement
    expect(badge.className).toContain('text-fluux-muted')
    expect(badge.querySelector('.lucide-shield-check')).toBeNull()
    expect(container.querySelector('[data-testid="omemo-verify-ABCD1234"]')).not.toBeNull()
  })

  it('getGlance: verified → ShieldCheck/glanceVerified/success', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'verified' }, identity)
    expect(g).toEqual({ icon: ShieldCheck, label: 'contacts.encryption.glanceVerified', tone: 'success' })
  })

  it('getGlance: tofu → Lock/glanceEncrypted/neutral', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'tofu' }, identity)
    expect(g).toEqual({ icon: Lock, label: 'contacts.encryption.glanceEncrypted', tone: 'neutral' })
  })

  it('getGlance: tofu (firstSeen) → Lock/glanceEncrypted/neutral (not verified)', () => {
    const g = getGlance({ kind: 'encrypted', fingerprint: 'FP', trust: 'tofu', firstSeen: true }, identity)
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

  it('ChatHeader: tofu (not verified) → gray Shield (not ShieldCheck) on the trigger button', () => {
    const { container } = renderHeader('tofu')
    const shield = container.querySelector('button .lucide-shield')
    expect(shield).not.toBeNull()
    expect(container.querySelector('button .lucide-shield-check')).toBeNull()
    const button = shield!.closest('button')!
    expect(button.getAttribute('class')).toContain('text-fluux-muted')
    // `chat.verifyPeer.chipAriaLabel` is likewise absent from the test i18n
    // subset, so it too falls back to the raw key.
    expect(button.getAttribute('aria-label')).toBe('chat.verifyPeer.chipAriaLabel')
  })

  it('ChatHeader: tofu (firstSeen) → same gray Shield + same aria-label as tofu (current quirk, no distinct chip)', () => {
    const { container } = renderHeader('tofu', true)
    const shield = container.querySelector('button .lucide-shield')
    expect(shield).not.toBeNull()
    expect(container.querySelector('button .lucide-shield-check')).toBeNull()
    const button = shield!.closest('button')!
    expect(button.getAttribute('class')).toContain('text-fluux-muted')
    expect(button.getAttribute('aria-label')).toBe('chat.verifyPeer.chipAriaLabel')
  })

  it('ChatHeader: tofu vs tofu (firstSeen) hover tooltips differ (calm firstSeen copy has a real default string; plain tofu falls back to raw key)', async () => {
    vi.useFakeTimers()
    try {
      const unverified = renderHeader('tofu')
      const unverifiedButton = unverified.container.querySelector('button')!
      fireEvent.mouseEnter(unverifiedButton)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700)
      })
      // `chat.encryption.openpgpTooltip` has no defaultValue in ChatHeader.tsx
      // and isn't in the test i18n subset, so it falls back to the raw key.
      expect(document.body.textContent).toContain('chat.encryption.openpgpTooltip')
      unverified.unmount()

      const tofuNew = renderHeader('tofu', true)
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
