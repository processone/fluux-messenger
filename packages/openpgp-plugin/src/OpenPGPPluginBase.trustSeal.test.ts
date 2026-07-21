/**
 * B3 Task 5 review Finding 1: every existing Task-5 test drove
 * `migrateLegacyTrustSeal(storage, ACCOUNT)` directly — nothing exercised
 * the call site inside `OpenPGPPluginBase.init()` itself
 * (`await migrateLegacyTrustSeal(ctx.storage, getBareJid(ctx.account.jid))`).
 * Deleting that line left the entire 513-test suite green.
 *
 * Why that matters: for an upgrading user with a legacy seal blob + init
 * flag, a regression on that call site means the migration never runs ->
 * `PluginStorage` has no blob and no flag -> `verifyTrustStateSeal` returns
 * `pending-seal` -> `verifyTrustStateOnInit` auto-calls `sealTrustStateNow()`,
 * silently re-sealing over whatever state is present. Any tampering
 * committed before the upgrade is permanently laundered, invisibly, with the
 * legacy keys orphaned in `localStorage`.
 *
 * Mirrors `OpenPGPPluginBase.syncVersion.test.ts`'s wiring-test shape (same
 * `makeTestBase()` / `makeTestCtx()` harness) — that file already
 * established the precedent for driving a legacy-seed migration through the
 * real `init()` entry point instead of only the isolated migration function.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { buildScopedStorageKey } from '@fluux/sdk'
import { makeTestBase, makeTestCtx } from './testSupport/baseHarness'
import { hasStoredSeal, SEAL_STORAGE_KEY, INIT_FLAG_STORAGE_KEY } from './trustStateIntegrity'
import type { KeyBundle } from './OpenPGPPluginBase'

const ACCOUNT = 'alice@example.com'
const LEGACY_SEAL_KEY_BASE = 'fluux-e2ee-trust-state-seal'
const LEGACY_INIT_FLAG_KEY_BASE = 'fluux-e2ee-trust-integrity-init'

function scopedLegacySealKey(accountJid = ACCOUNT): string {
  return buildScopedStorageKey(LEGACY_SEAL_KEY_BASE, accountJid)
}

function scopedLegacyInitFlagKey(accountJid = ACCOUNT): string {
  return buildScopedStorageKey(LEGACY_INIT_FLAG_KEY_BASE, accountJid)
}

function canonicalBundle(fingerprint = 'AA'.repeat(20)): KeyBundle {
  return { fingerprint, publicArmored: '', keychainBacked: false }
}

const dec = new TextDecoder()

beforeEach(() => {
  localStorage.clear()
})

describe('OpenPGPPluginBase.init() — trust-state seal legacy migration wiring (B3 Task 5)', () => {
  it('legacy scoped seal + flag present -> seeded through init() into PluginStorage, persisted, and the legacy keys are gone', async () => {
    localStorage.setItem(scopedLegacySealKey(), 'ARMORED-BLOB')
    localStorage.setItem(scopedLegacyInitFlagKey(), '1')

    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(await hasStoredSeal(ctx.storage)).toBe(true)
    expect(dec.decode((await ctx.storage.get(SEAL_STORAGE_KEY))!)).toBe('ARMORED-BLOB')
    expect(dec.decode((await ctx.storage.get(INIT_FLAG_STORAGE_KEY))!)).toBe('1')
    expect(localStorage.getItem(scopedLegacySealKey())).toBeNull()
    expect(localStorage.getItem(scopedLegacyInitFlagKey())).toBeNull()
  })

  it('legacy UNSCOPED seal + flag present -> same outcome through init()', async () => {
    localStorage.setItem(LEGACY_SEAL_KEY_BASE, 'ARMORED-BLOB')
    localStorage.setItem(LEGACY_INIT_FLAG_KEY_BASE, '1')

    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(await hasStoredSeal(ctx.storage)).toBe(true)
    expect(dec.decode((await ctx.storage.get(SEAL_STORAGE_KEY))!)).toBe('ARMORED-BLOB')
    expect(localStorage.getItem(LEGACY_SEAL_KEY_BASE)).toBeNull()
    expect(localStorage.getItem(LEGACY_INIT_FLAG_KEY_BASE)).toBeNull()
  })

  it('nothing legacy present -> init() completes and PluginStorage has no seal (no-op path also runs through the real call site)', async () => {
    const { base } = makeTestBase()
    base.ensureKeyMaterialImpl = async () => canonicalBundle()
    const ctx = makeTestCtx(ACCOUNT)

    await base.init(ctx)

    expect(await hasStoredSeal(ctx.storage)).toBe(false)
  })
})
