/**
 * What a person sees for one contact's encryption state: the composer lock,
 * the header shield and its tooltip, and the Security tab.
 *
 * Intent (FLM-268, piece 2): the app reads trust through the SDK alone and
 * nothing visible changes. These cases were written on the version that read
 * the OpenPGP plugin and its stores directly, and pass unchanged on the version
 * that reads the SDK's identity API. The composer lock, header and glance
 * assertions are that unchanged baseline. The Security tab's `tabText`,
 * `tabButtons` and `fingerprints` were deliberately revised in piece 3
 * (FLM-274), which replaces the single fingerprint with one row per key, each
 * with its trust tag, whether it receives messages and its decisions.
 * They drive the hook from an OpenPGP plugin registered with a real
 * E2EEManager, so they hold the data side fixed and compare only what is
 * rendered.
 *
 * Issue #1452 (OpenPGP half) deliberately revised the cases of a verified
 * contact with a new key: that key now waits for the user's decision and
 * receives nothing meanwhile, and every key offers its own decisions.
 *
 * The plugin is a stand-in that follows the real one's rules through the
 * plugin's own trust records and `keyStanding` (one identity per announced key,
 * a verified contact's undecided key held, a replaced verified key listed as
 * unused, rejected certificates listed with their reason); the real one is
 * covered in packages/openpgp-plugin. `recentlyMet` stands for a protocol that
 * marks a contact met recently, which the SDK reports as `isNew`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { E2EEPlugin, PeerIdentity, PluginContext } from '@fluux/sdk'
import { E2EEManager, InMemoryStorageBackend, createPluginStorage } from '@fluux/sdk'
import { TrustRecordStore, canonicalFingerprint, keyStanding } from '@fluux/openpgp-plugin'
import { DummyPlaintextPlugin } from '../../../../packages/fluux-sdk/src/core/e2ee/DummyPlaintextPlugin'
import { useConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { ChatHeader } from '@/components/ChatHeader'
import { MessageComposer } from '@/components/MessageComposer'
import { SecurityGlanceCard } from '@/components/contact-profile/cards/SecurityGlanceCard'
import { SecurityTab } from '@/components/contact-profile/tabs/SecurityTab'
import { HeldKeysBanner } from '@/components/HeldKeysBanner'
import { useConversationPlaintextOverrideStore } from '@/stores/conversationPlaintextOverrideStore'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

const PEER = 'bob@example.com'
const A = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const B = 'BBBB1111CCCC2222DDDD3333EEEE4444FFFF5555'

const world = vi.hoisted(() => ({ announced: [] as string[], locked: false, recentlyMet: false, listCalls: 0, failListingFrom: null as number | null }))
const manager = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useConnectionStatus: () => ({ status: 'online' }),
    useXMPPContext: () => ({ client: { e2ee: manager.current } }),
  }
})
vi.mock('@/hooks/useWebKeyLocked', () => ({ useWebKeyLocked: () => world.locked }))
vi.mock('@/hooks', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  useWindowDrag: () => ({ dragRegionProps: {} }),
  useAnchoredMenu: () => ({ triggerRef: { current: null }, menuRef: { current: null }, position: { x: 0, y: 0 } }),
  useClickOutside: () => {},
}))
vi.mock('@/hooks/useHasHover', () => ({ useHasHover: () => true, hasHover: () => true }))
vi.mock('@fluux/sdk/react', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useRosterStore: (selector: (s: { contacts: Map<string, unknown> }) => unknown) => selector({ contacts: new Map() }),
    useConnectionStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'online' }),
    useContactTime: () => null,
    useLastActivity: vi.fn(),
  }
})

/** The stand-in's trust records: the user's decision about each key, and rejected certificates. */
let records: TrustRecordStore

/** An OpenPGP plugin over its own trust records, answering both the plugin's own calls and the identity API. */
class OpenPgpStandIn extends DummyPlaintextPlugin implements E2EEPlugin {
  override readonly descriptor = { ...new DummyPlaintextPlugin().descriptor, id: 'openpgp', displayName: 'OpenPGP', securityLevel: 40 }
  override async init(ctx: PluginContext) {
    records.subscribe(() => ctx.reportPeerIdentitiesChanged?.(PEER))
  }
  getPeerFingerprints(): string[] {
    return [...world.announced]
  }
  getPeerFingerprint(): string | null {
    return world.announced[0] ?? null
  }
  override async probePeer() {
    return { supported: world.announced.length > 0, fingerprint: world.announced[0], ttl: 60 }
  }
  isLocked() {
    return world.locked
  }
  getOwnFingerprint() {
    return 'OWNFP'
  }
  async listPeerIdentities(peer: string): Promise<PeerIdentity[]> {
    world.listCalls += 1
    if (world.failListingFrom !== null && world.listCalls >= world.failListingFrom) throw new Error('listing failed')
    const decisions = records.decisionsView(peer)
    const holds = records.hasVerified(peer)
    const out: PeerIdentity[] = world.announced.map((fp) => {
      const standing = keyStanding(decisions[canonicalFingerprint(fp)!], holds)
      return {
        id: fp,
        fingerprint: fp,
        trust: standing.trust,
        usedForEncryption: standing.used,
        ...(standing.notUsedReason ? { notUsedReason: standing.notUsedReason } : {}),
        allowedDecisions: [...standing.allowedDecisions],
        ...(world.recentlyMet && standing.used && standing.trust !== 'verified' ? { isNew: true } : {}),
      }
    })
    const listed = (fp: string) => out.findIndex((i) => canonicalFingerprint(i.id) === canonicalFingerprint(fp))
    if (out.length > 0) {
      for (const fp of records.verifiedFingerprints(peer)) {
        if (listed(fp) >= 0) continue
        out.push({ id: fp, fingerprint: fp, trust: 'verified', usedForEncryption: false, notUsedReason: 'no-key', allowedDecisions: ['tofu'] })
      }
    }
    for (const r of records.rejectionsOf(peer)) {
      if (listed(r.fingerprint) >= 0) continue
      out.push({
        id: r.fingerprint, fingerprint: r.fingerprint, trust: 'unknown', usedForEncryption: false,
        notUsedReason: 'invalid-key', problem: { code: r.code, detail: r.detail }, allowedDecisions: [],
      })
    }
    return out
  }
  async setIdentityTrust(peer: string, id: string, decision: 'verified' | 'tofu' | 'untrusted') {
    records.setDecision(peer, id, decision)
  }
}

function Surfaces() {
  const state = useConversationEncryptionState(PEER, 'chat')
  return (
    <div>
      <div data-testid="header">
        <ChatHeader
          name="Bob" type="chat" jid={PEER} encryptionState={state}
          onEncryptionClick={() => {}} onDisableEncryptionClick={() => {}} onEnableEncryptionClick={() => {}}
        />
      </div>
      <div data-testid="composer">
        <MessageComposer placeholder="Type a message" onSend={vi.fn().mockResolvedValue(true)} encryptionState={state} />
      </div>
      <div data-testid="glance">
        <SecurityGlanceCard state={state} onOpen={() => {}} />
      </div>
      <div data-testid="tab">
        <SecurityTab state={state} onDecide={() => {}} onDisableEncryption={() => {}} onEnableEncryption={() => {}} />
      </div>
      <div data-testid="notice">
        <HeldKeysBanner state={state} peerName="Bob" />
      </div>
    </div>
  )
}

/** What each surface shows, as text a person could read. */
function seen() {
  const lock = screen.getByTestId('composer').querySelector('[data-encryption-lock]')
  const tab = screen.getByTestId('tab')
  return {
    composerLock: lock
      ? {
          label: lock.getAttribute('aria-label'),
          icon: [...lock.querySelectorAll('svg')].map((s) => s.getAttribute('class')?.match(/lucide-[\w-]+/)?.[0]),
          color: [...lock.querySelectorAll('svg')].map((s) => s.getAttribute('class')?.match(/text-fluux-[\w-]+/)?.[0]),
        }
      : null,
    headerColors: [...screen.getByTestId('header').querySelectorAll('button[aria-label]')]
      .filter((b) => /encryption|verifyPeer/i.test(b.getAttribute('aria-label')!))
      .map((b) => b.className.match(/text-fluux-[\w-]+/)?.[0]),
    glance: screen.getByTestId('glance').textContent,
    glanceColors: [...screen.getByTestId('glance').querySelectorAll('[class*="text-fluux-"]')].map((e) => e.getAttribute('class')?.match(/text-fluux-[\w-]+/)?.[0]),
    headerButtons: [...screen.getByTestId('header').querySelectorAll('button[aria-label]')]
      .map((b) => b.getAttribute('aria-label')!)
      .filter((l) => /encryption|verifyPeer/i.test(l)),
    tabText: tab.textContent,
    tabButtons: [...tab.querySelectorAll('button')].map((b) => b.textContent),
    fingerprints: [...tab.querySelectorAll('code')].map((c) => c.textContent),
  }
}

async function open() {
  render(<Surfaces />)
  // The state settles once the manager has answered.
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
}

describe('encryption state as people see it', () => {
  beforeEach(async () => {
    localStorage.clear()
    world.announced = []
    world.locked = false
    world.listCalls = 0
    world.failListingFrom = null
    world.recentlyMet = false
    records = new TrustRecordStore()
    await records.attach(createPluginStorage(new InMemoryStorageBackend(), 'e2ee/openpgp'))
    useConversationPlaintextOverrideStore.setState({ plaintextJids: {} })
    useEncryptionSettingsStore.setState({ openpgpEnabled: true, pluginRegisteredAt: Date.now() })
    const m = new E2EEManager({
      storage: new InMemoryStorageBackend(),
      xmpp: {
        sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }), publishPEP: async () => {},
        retractPEP: async () => {}, deletePEP: async () => {}, queryPEP: async () => [], subscribePEP: () => ({ unsubscribe: () => {} }),
      },
      account: { jid: 'me@example.com' },
    })
    await m.register(new OpenPgpStandIn())
    manager.current = m
  })
  afterEach(() => {
    manager.current = null
  })

  it('an unverified one-key contact: gray shield, Verify offered', async () => {
    world.announced = [A]
    await open()
    expect(seen()).toMatchInlineSnapshot(`
      {
        "composerLock": {
          "color": [
            "text-fluux-muted",
          ],
          "icon": [
            "lucide-shield",
          ],
          "label": "chat.encryption.openpgpTooltip",
        },
        "fingerprints": [
          "AAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555",
        ],
        "glance": "Encrypted, not verified",
        "glanceColors": [
          "text-fluux-muted",
          "text-fluux-text",
          "text-fluux-muted",
        ],
        "headerButtons": [
          "chat.verifyPeer.chipAriaLabel",
        ],
        "headerColors": [
          "text-fluux-muted",
        ],
        "tabButtons": [
          "Verify fingerprint",
          "contacts.encryption.distrustButton",
          "contacts.encryption.disableForContact",
        ],
        "tabText": "Encrypted (not verified)OpenPGPcontacts.encryption.keyTrust.tofuAAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555contacts.encryption.receivesMessagesVerify fingerprintcontacts.encryption.distrustButtoncontacts.encryption.disableForContact",
      }
    `)
  })

  it('a recently met contact: gray shield, new-contact wording', async () => {
    world.announced = [A]
    world.recentlyMet = true
    await open()
    expect(seen()).toMatchInlineSnapshot(`
      {
        "composerLock": {
          "color": [
            "text-fluux-muted",
          ],
          "icon": [
            "lucide-shield",
          ],
          "label": "chat.encryption.openpgpTooltip",
        },
        "fingerprints": [
          "AAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555",
        ],
        "glance": "Encrypted, not verified",
        "glanceColors": [
          "text-fluux-muted",
          "text-fluux-text",
          "text-fluux-muted",
        ],
        "headerButtons": [
          "chat.verifyPeer.chipAriaLabel",
        ],
        "headerColors": [
          "text-fluux-muted",
        ],
        "tabButtons": [
          "Verify fingerprint",
          "contacts.encryption.distrustButton",
          "contacts.encryption.disableForContact",
        ],
        "tabText": "Encrypted (not verified)OpenPGPcontacts.encryption.keyTrust.tofuAAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555contacts.encryption.receivesMessagesVerify fingerprintcontacts.encryption.distrustButtoncontacts.encryption.disableForContact",
      }
    `)
  })

  it('a verified one-key contact: teal shield, Remove verification offered', async () => {
    world.announced = [A]
    records.setDecision(PEER, A, 'verified')
    await open()
    expect(seen()).toMatchInlineSnapshot(`
      {
        "composerLock": {
          "color": [
            "text-fluux-encryption",
          ],
          "icon": [
            "lucide-shield-check",
          ],
          "label": "chat.encryption.verifiedTooltip",
        },
        "fingerprints": [
          "AAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555",
        ],
        "glance": "Verified and encrypted",
        "glanceColors": [
          "text-fluux-encryption",
          "text-fluux-text",
          "text-fluux-muted",
        ],
        "headerButtons": [
          "chat.encryption.encryptedTo",
        ],
        "headerColors": [
          "text-fluux-encryption",
        ],
        "tabButtons": [
          "contacts.encryption.removeVerification",
          "contacts.encryption.distrustButton",
          "contacts.encryption.disableForContact",
        ],
        "tabText": "VerifiedOpenPGPcontacts.encryption.keyTrust.verifiedAAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555contacts.encryption.receivesMessagescontacts.encryption.removeVerificationcontacts.encryption.distrustButtoncontacts.encryption.disableForContact",
      }
    `)
  })

  it('a verified key that differs only in letter case still reads verified', async () => {
    world.announced = [A]
    records.setDecision(PEER, A.toLowerCase(), 'verified')
    await open()
    expect(seen().composerLock?.icon).toEqual(['lucide-shield-check'])
  })

  it('a verified contact who announces an extra key: still verified, the new key waits for a decision', async () => {
    world.announced = [A, B]
    records.setDecision(PEER, A, 'verified')
    await open()
    // Issue #1452: messages go to the verified key only. The new key is listed with its own
    // decisions and receives nothing until the user trusts or verifies it.
    expect(seen()).toMatchInlineSnapshot(`
      {
        "composerLock": {
          "color": [
            "text-fluux-encryption",
          ],
          "icon": [
            "lucide-shield-check",
          ],
          "label": "chat.encryption.verifiedTooltip",
        },
        "fingerprints": [
          "AAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555",
          "BBBB 1111 CCCC 2222 DDDD 3333 EEEE 4444 FFFF 5555",
        ],
        "glance": "Verified and encrypted",
        "glanceColors": [
          "text-fluux-encryption",
          "text-fluux-text",
          "text-fluux-muted",
        ],
        "headerButtons": [
          "chat.encryption.encryptedTo",
        ],
        "headerColors": [
          "text-fluux-encryption",
        ],
        "tabButtons": [
          "contacts.encryption.removeVerification",
          "contacts.encryption.distrustButton",
          "Verify fingerprint",
          "contacts.encryption.trustButton",
          "contacts.encryption.distrustButton",
          "contacts.encryption.disableForContact",
        ],
        "tabText": "VerifiedOpenPGPcontacts.encryption.keyTrust.verifiedAAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555contacts.encryption.receivesMessagescontacts.encryption.removeVerificationcontacts.encryption.distrustButtoncontacts.encryption.keyTrust.unknownBBBB 1111 CCCC 2222 DDDD 3333 EEEE 4444 FFFF 5555contacts.encryption.receivesNoMessages: contacts.encryption.notUsedReason.awaiting-decisionVerify fingerprintcontacts.encryption.trustButtoncontacts.encryption.distrustButtoncontacts.encryption.disableForContact",
      }
    `)
  })

  it('a verified key the contact replaced: the new key waits for a decision and nothing is encrypted', async () => {
    world.announced = [B]
    records.setDecision(PEER, A, 'verified')
    await open()
    expect(seen()).toMatchInlineSnapshot(`
      {
        "composerLock": null,
        "fingerprints": [
          "BBBB 1111 CCCC 2222 DDDD 3333 EEEE 4444 FFFF 5555",
          "AAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555",
        ],
        "glance": "contacts.encryption.needsDecisionTitle",
        "glanceColors": [
          "text-fluux-yellow",
          "text-fluux-text",
          "text-fluux-muted",
        ],
        "headerButtons": [],
        "headerColors": [],
        "tabButtons": [
          "Verify fingerprint",
          "contacts.encryption.trustButton",
          "contacts.encryption.distrustButton",
          "contacts.encryption.removeVerification",
        ],
        "tabText": "contacts.encryption.needsDecisionTitlecontacts.encryption.needsDecisionDescriptionOpenPGPcontacts.encryption.keyTrust.unknownBBBB 1111 CCCC 2222 DDDD 3333 EEEE 4444 FFFF 5555contacts.encryption.receivesNoMessages: contacts.encryption.notUsedReason.awaiting-decisionVerify fingerprintcontacts.encryption.trustButtoncontacts.encryption.distrustButtoncontacts.encryption.keyTrust.verifiedAAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555contacts.encryption.receivesNoMessages: contacts.encryption.notUsedReason.no-keycontacts.encryption.removeVerification",
      }
    `)
  })

  it('a recently met contact whose verified key was replaced still offers Verify', async () => {
    world.announced = [B]
    world.recentlyMet = true
    records.setDecision(PEER, A, 'verified')
    await open()
    expect(seen().tabButtons).toContain('Verify fingerprint')
    // The new key is held whatever the protocol says about the contact: no lock, nothing encrypted to it.
    expect(seen().composerLock).toBeNull()
  })

  it('a never-verified contact with two keys: plain gray shield', async () => {
    world.announced = [A, B]
    await open()
    expect(seen().composerLock?.icon).toEqual(['lucide-shield'])
    expect(seen().composerLock?.label).not.toBe('This contact has a new key that has not been verified.')
    expect(seen().tabText).not.toContain('new key')
  })

  it('flips to verified when the contact is verified while the chat is open', async () => {
    world.announced = [A]
    await open()
    expect(seen().composerLock?.icon).toEqual(['lucide-shield'])
    await act(async () => { await (manager.current as E2EEManager).setIdentityTrust('openpgp', PEER, A, 'verified') })
    await waitFor(() => expect(seen().composerLock?.icon).toEqual(['lucide-shield-check']))
  })

  it('a contact without a usable key: no lock', async () => {
    await open()
    expect(seen().composerLock).toBeNull()
    expect(seen().headerButtons).toEqual([])
  })

  it('a contact whose only certificates were rejected: rejected explanation with each reason', async () => {
    records.setRejections(PEER, [{ fingerprint: B, code: 'no_encryption_subkey', detail: 'no subkey', observedAt: '2024-01-01T00:00:00Z' }])
    await open()
    expect(seen()).toMatchInlineSnapshot(`
      {
        "composerLock": null,
        "fingerprints": [
          "BBBB 1111 CCCC 2222 DDDD 3333 EEEE 4444 FFFF 5555",
          "no subkey",
        ],
        "glance": "contacts.encryption.rejectedTitle",
        "glanceColors": [
          "text-fluux-error",
          "text-fluux-text",
          "text-fluux-muted",
        ],
        "headerButtons": [
          "chat.encryption.rejected",
        ],
        "headerColors": [
          "text-fluux-error",
        ],
        "tabButtons": [],
        "tabText": "contacts.encryption.rejectedTitlecontacts.encryption.rejectedDescriptionOpenPGPcontacts.encryption.keyTrust.unknownBBBB 1111 CCCC 2222 DDDD 3333 EEEE 4444 FFFF 5555contacts.encryption.receivesNoMessages: contacts.encryption.notUsedReason.invalid-keyno_encryption_subkeyno subkey",
      }
    `)
  })

  it('encryption turned off for the contact: forced-plaintext explanation, no lock', async () => {
    world.announced = [A]
    useConversationPlaintextOverrideStore.setState({ plaintextJids: { [PEER]: true } })
    ;(manager.current as E2EEManager).setForcedPlaintext({ kind: 'direct', peer: PEER }, true)
    await open()
    expect(seen()).toMatchInlineSnapshot(`
      {
        "composerLock": null,
        "fingerprints": [],
        "glance": "Encryption off",
        "glanceColors": [
          "text-fluux-muted",
          "text-fluux-text",
          "text-fluux-muted",
        ],
        "headerButtons": [
          "chat.encryption.plaintextForced",
        ],
        "headerColors": [
          "text-fluux-muted",
        ],
        "tabButtons": [
          "chat.encryption.enableEncryption",
        ],
        "tabText": "contacts.encryption.disabledByYouTitlecontacts.encryption.disabledByYouDescriptionchat.encryption.enableEncryption",
      }
    `)
  })

  it('the own key locked: unlock affordance in the header, no composer lock', async () => {
    world.announced = [A]
    world.locked = true
    await open()
    expect(seen()).toMatchInlineSnapshot(`
      {
        "composerLock": null,
        "fingerprints": [
          "AAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555",
        ],
        "glance": "Encrypted, locked",
        "glanceColors": [
          "text-fluux-muted",
          "text-fluux-text",
          "text-fluux-muted",
        ],
        "headerButtons": [
          "chat.encryption.keyLocked",
        ],
        "headerColors": [
          "text-fluux-muted",
        ],
        "tabButtons": [
          "Verify fingerprint",
          "contacts.encryption.distrustButton",
        ],
        "tabText": "chat.encryption.keyLockedchat.encryption.keyLockedTooltipOpenPGPcontacts.encryption.keyTrust.tofuAAAA 1111 BBBB 2222 CCCC 3333 DDDD 4444 EEEE 5555contacts.encryption.receivesWhenUnlockedVerify fingerprintcontacts.encryption.distrustButton",
      }
    `)
  })

  it('the header tooltip names the new-contact state', async () => {
    world.announced = [A]
    world.recentlyMet = true
    await open()
    vi.useFakeTimers()
    try {
      const shield = screen.getByTestId('header').querySelector('button[aria-label="chat.verifyPeer.chipAriaLabel"]')!
      fireEvent.mouseEnter(shield.parentElement!)
      act(() => { vi.advanceTimersByTime(1000) })
    } finally {
      vi.useRealTimers()
    }
    expect(screen.getByText(/New contact/)).toBeInTheDocument()
  })

  it('a listing that fails after the first read: a list error that Try again recovers, never missing rows', async () => {
    world.announced = [A]
    // The manager's own read succeeds (call 1); the app's listing (call 2) fails and the manager drops the plugin.
    world.failListingFrom = 2
    await open()
    const tab = screen.getByTestId('tab')
    expect(tab.textContent).toContain('contacts.encryption.listErrorTitle')
    // The conversation stays encrypted: the composer keeps its lock and sends, uploads included, stay encrypted.
    expect(seen().composerLock?.label).toBe('chat.encryption.openpgpTooltip')
    expect(tab.querySelectorAll('[data-testid="identity-row"]')).toHaveLength(0)
    world.failListingFrom = null
    fireEvent.click(within(tab).getByRole('button', { name: 'contacts.encryption.tryAgain' }))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(tab.querySelectorAll('[data-testid="identity-row"]')).toHaveLength(1)
    expect(tab.textContent).not.toContain('contacts.encryption.listErrorTitle')
  })

  it('a listing that fails from the manager\'s own first read: still encrypted, so uploads stay encrypted', async () => {
    world.announced = [A]
    world.failListingFrom = 1
    await open()
    expect(screen.getByTestId('tab').textContent).toContain('contacts.encryption.listErrorTitle')
    // Not a downgrade to "unsupported": the composer keeps its lock, which is what keeps an attachment encrypted.
    expect(seen().composerLock?.label).toBe('chat.encryption.openpgpTooltip')
  })

  it('a listing that fails while the own key is locked: still locked, with a list error to retry', async () => {
    world.announced = [A]
    world.locked = true
    // A locked plugin lists nothing for the manager's own read, so the app's listing is call 1.
    world.failListingFrom = 1
    await open()
    expect(screen.getByTestId('tab').textContent).toContain('contacts.encryption.listErrorTitle')
    // The header keeps its unlock affordance, so a send still asks to unlock and uploads nothing.
    expect(seen().headerButtons.length).toBeGreaterThan(0)
  })

  // Issue #1452: the conversation says why a contact's key receives nothing.
  describe('the held-keys notice in the conversation', () => {
    const notice = () => screen.getByTestId('notice').textContent

    it('explains the new key of a verified contact while the verified key keeps receiving', async () => {
      world.announced = [A, B]
      records.setDecision(PEER, A, 'verified')
      await open()
      expect(notice()).toContain('chat.encryption.heldKeys.partial')
      expect(seen().composerLock?.icon).toEqual(['lucide-shield-check'])
    })

    it('says nothing can be sent when the only key of a verified contact is new', async () => {
      world.announced = [B]
      records.setDecision(PEER, A, 'verified')
      await open()
      expect(notice()).toContain('chat.encryption.heldKeys.all')
    })

    it('says nothing for a never-verified contact, whose new keys are used at once', async () => {
      world.announced = [A, B]
      await open()
      expect(notice()).toBe('')
      expect(seen().tabText).not.toContain('notUsedReason.awaiting-decision')
    })

    it('goes away once the user trusts the new key, which then receives messages', async () => {
      world.announced = [A, B]
      records.setDecision(PEER, A, 'verified')
      await open()
      expect(notice()).toContain('chat.encryption.heldKeys.partial')
      await act(async () => { await (manager.current as E2EEManager).setIdentityTrust('openpgp', PEER, B, 'tofu') })
      await waitFor(() => expect(notice()).toBe(''))
      expect(seen().tabText).not.toContain('notUsedReason.awaiting-decision')
    })

    it('explains a contact whose every key the user refused, everywhere it shows', async () => {
      world.announced = [A]
      records.setDecision(PEER, A, 'untrusted')
      await open()
      expect(notice()).toContain('chat.encryption.heldKeys.distrusted')
      expect(seen().glance).toContain('contacts.encryption.distrustedTitle')
      expect(seen().headerButtons).toEqual(['contacts.encryption.distrustedTitle'])
      expect(seen().tabText).toContain('contacts.encryption.distrustedDescription')
      expect(seen().tabText).not.toContain('contacts.encryption.rejectedDescription')
    })
  })

})
