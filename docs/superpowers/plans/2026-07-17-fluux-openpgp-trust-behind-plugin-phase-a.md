# OpenPGP Trust-Behind-the-Plugin — Phase A (Trait Conformance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenPGP plugin conform to the shared per-identity trust API (`listPeerIdentities` / `setIdentityTrust`) and render OpenPGP through the same shared per-identity UI as OMEMO, retiring the app-side `protocolId === 'omemo:2'` gating.

**Architecture:** Add the two optional `E2EEPlugin` trait methods to `OpenPGPPluginBase` (backed by the existing `hostStores.verifiedPeers` seam — no storage migration in this phase). Generalize `SecurityTab` (`OmemoDeviceList` → protocol-neutral `PeerIdentityList`) and `ContactProfileView`/`ContactSecurityDetail` (the `omemo` per-identity handle → a protocol-neutral `identities` handle built for whichever plugin drives the conversation). The composer/ChatHeader/glance path and `useConversationEncryptionState` are **not** touched — OpenPGP's `trust`/`firstSeen` derivation stays exactly as today.

**Tech Stack:** TypeScript, React, Zustand, Vitest + Testing Library, i18next (`nsSeparator: false` already set for the `omemo:2` colon).

**Spec:** `docs/superpowers/specs/2026-07-17-fluux-openpgp-trust-behind-plugin-design.md`. This plan is **Phase A only**. Phase B (move verified data into `PluginStorage`, rework the integrity seal + verification-sync, delete `hostStores.verifiedPeers`) is deferred to its own spec + plan — grounding found it entangles the remote verification-sync backup and the synchronous seal snapshot, a larger security-sensitive refactor.

## Global Constraints

- **Crypto core untouched.** No changes to `@fluux/omemo` or `src-tauri`. No backup-byte changes → **no Sequoia interop vector regeneration**.
- **No storage migration in Phase A.** OpenPGP trait methods read/write the existing `hostStores.verifiedPeers` seam. `verifiedPeerKeysStore`, its localStorage key (`fluux-e2ee-verified-peers`), the integrity seal, and the verification-sync path are untouched.
- **Composer / ChatHeader / glance rendering must not change.** `useConversationEncryptionState` is not modified. The characterization tests in `apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx` for `getGlance` and `ChatHeader` MUST keep passing verbatim. Only the SecurityTab characterization tests change (the SecurityTab OpenPGP panel is intentionally replaced by the shared list).
- **OMEMO behavior preserved.** OMEMO's SecurityTab list must render identically (same rows, badges, verify/revoke, error/retry, testids) after the rename. `SecurityTab.omemo.test.tsx` must keep passing (updated only for the prop rename `omemo` → `identities`, never for behavior).
- **Shared trust vocabulary only.** Trust rendering goes through `trustStateVisual` / `trustLabel`. No parallel OpenPGP trust vocabulary.
- **SDK types unchanged.** `PeerIdentity` (`{ id, fingerprint, trust }`) and `TrustState` are already generic. `listPeerIdentities?` / `setIdentityTrust?` are already-optional trait members. No SDK edits.
- **i18n:** Claude translates all 33 locales for any new key (surgical locale edits: parse → mutate → `JSON.stringify(obj, null, 4) + "\n"`). No em-dash connectors in copy.
- **App mock upkeep:** new plugin surface used by the app → update app mocks via `importOriginal` spread; respect the `RoomView.test.tsx` barrel-free exception.
- **Commits `--no-gpg-sign`** (sandbox ssh-agent broken; re-signed later from RustRover). Never push. No Claude footer.
- **Gate each task:** the touched workspace's typecheck + the touched test files green, no stderr.

## File Structure

- `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` — add `listPeerIdentities` + `setIdentityTrust` (Task 1).
- `packages/openpgp-plugin/src/OpenPGPPluginBase.trait.test.ts` — **new** unit tests for the two methods (Task 1).
- `apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx` — `omemo` prop → `identities`; `OmemoDeviceList` → `PeerIdentityList` with protocol-appropriate label; capability gate (Task 2).
- `apps/fluux/src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx` — updated for the prop rename (Task 2).
- `apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx` — SecurityTab section rewritten for the shared list; `getGlance`/`ChatHeader` sections untouched (Task 2).
- `apps/fluux/public/locales/*/translation.json` (33) — neutral `contacts.encryption.identity.*` keys (Task 3).
- `apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx` — prop passthrough rename (Task 4).
- `apps/fluux/src/components/ContactProfileView.tsx` — build the protocol-neutral `identities` handle for OpenPGP **and** OMEMO; wire OpenPGP verify/revoke through `setIdentityTrust` (Task 4).

---

### Task 1: OpenPGP plugin trait methods (`listPeerIdentities` + `setIdentityTrust`)

**Files:**
- Modify: `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` (add two methods in the "Trust evaluation" section, after `evaluatePeerTrust` at ~`:2042`; ensure `PeerIdentity` is imported from `@fluux/sdk` and `fingerprintsEqual` from `./fingerprintCompare`)
- Create: `packages/openpgp-plugin/src/OpenPGPPluginBase.trait.test.ts`

**Interfaces:**
- Consumes: `this.peerKeys: Map<BareJID, KeyBundle>` (KeyBundle has `.fingerprint`), `this.getPeerFingerprint(peer)`, `this.evaluatePeerTrust(peer)`, `this.hostStores.verifiedPeers.{setVerified,clearVerified}`, `fingerprintsEqual`.
- Produces (later tasks rely on these exact signatures):
  - `listPeerIdentities(peer: BareJID): Promise<PeerIdentity[]>` — `[]` when no key cached, else length-1 `[{ id: fp, fingerprint: fp, trust }]` where `fp` = the cached primary fingerprint.
  - `setIdentityTrust(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void>` — `'verified'` → `setVerified(peer, currentFp)`; `'untrusted'` → `clearVerified(peer)` (revoke → TOFU); no-op when no cached key or when a non-empty `id` no longer matches the current fingerprint.

- [ ] **Step 1: Confirm imports.** In `OpenPGPPluginBase.ts`, verify `PeerIdentity` is in the `@fluux/sdk` type import (add it if absent) and that `fingerprintsEqual` is imported from `./fingerprintCompare` (it is used elsewhere in the package; add the import if this file doesn't already have it).

- [ ] **Step 2: Write the failing tests.**

Create `packages/openpgp-plugin/src/OpenPGPPluginBase.trait.test.ts`. Because the two methods only touch `peerKeys`, `hostStores.verifiedPeers`, and `evaluatePeerTrust`, drive them through a minimal concrete subclass that exposes the private map and a stub `hostStores`. Match the construction pattern of the existing base tests in this package (a subclass instantiated with a fake `hostStores`); read `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` around the constructor and the existing `*.test.ts` files in the package to mirror how they build a base instance and seed `peerKeys`.

```ts
import { describe, it, expect } from 'vitest'
import { makeTestBase, seedPeerKey } from './testSupport/baseHarness' // reuse or create per existing package pattern

describe('OpenPGPPluginBase — per-identity trait', () => {
  it('listPeerIdentities returns [] when no key is cached', async () => {
    const { base } = makeTestBase()
    expect(await base.listPeerIdentities('bob@x')).toEqual([])
  })

  it('listPeerIdentities returns a length-1 identity (id === fingerprint) with tofu trust for a cached-but-unverified key', async () => {
    const { base, verified } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    verified.isVerified = () => false
    const list = await base.listPeerIdentities('bob@x')
    expect(list).toEqual([{ id: 'ABCD1234', fingerprint: 'ABCD1234', trust: 'tofu' }])
  })

  it('listPeerIdentities reports verified trust when the marker matches the cached fingerprint', async () => {
    const { base, verified } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    verified.isVerified = (jid, fp) => jid === 'bob@x' && fp === 'ABCD1234'
    const list = await base.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('verified')
  })

  it("setIdentityTrust('verified') pins the marker to the current fingerprint", async () => {
    const { base, verified, calls } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')
    expect(calls.setVerified).toEqual([['bob@x', 'ABCD1234']])
  })

  it("setIdentityTrust('untrusted') clears the marker (revoke → TOFU)", async () => {
    const { base, calls } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await base.setIdentityTrust('bob@x', 'ABCD1234', 'untrusted')
    expect(calls.clearVerified).toEqual([['bob@x']])
    expect(calls.setVerified).toEqual([])
  })

  it('setIdentityTrust no-ops when the peer has no cached key', async () => {
    const { base, calls } = makeTestBase()
    await base.setIdentityTrust('bob@x', 'ABCD1234', 'verified')
    expect(calls.setVerified).toEqual([])
    expect(calls.clearVerified).toEqual([])
  })

  it('setIdentityTrust no-ops when a non-empty id no longer matches the current fingerprint (TOCTOU guard)', async () => {
    const { base, calls } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'NEWFP9999')
    await base.setIdentityTrust('bob@x', 'STALEFP0000', 'verified')
    expect(calls.setVerified).toEqual([])
  })

  it('setIdentityTrust with an empty id acts on the current fingerprint (id optional)', async () => {
    const { base, calls } = makeTestBase()
    seedPeerKey(base, 'bob@x', 'ABCD1234')
    await base.setIdentityTrust('bob@x', '', 'verified')
    expect(calls.setVerified).toEqual([['bob@x', 'ABCD1234']])
  })
})
```

If the package has no reusable base harness, create `packages/openpgp-plugin/src/testSupport/baseHarness.ts` exposing `makeTestBase()` (returns `{ base, verified, calls }` where `verified` is the mutable `hostStores.verifiedPeers` stub recording `setVerified`/`clearVerified` calls) and `seedPeerKey(base, jid, fp)` (inserts into the private `peerKeys` map via a cast). Keep it minimal and test-only.

- [ ] **Step 3: Run the tests, verify they fail.**

Run: `cd packages/openpgp-plugin && npx vitest run src/OpenPGPPluginBase.trait.test.ts`
Expected: FAIL (`listPeerIdentities is not a function`).

- [ ] **Step 4: Implement the two methods.** Insert after `evaluatePeerTrust` (~`:2042`):

```ts
  /**
   * Per-identity trust list (E2EEPlugin trait). OpenPGP has exactly one
   * identity per peer — the primary key — so this returns a length-1 list
   * (`id` === the fingerprint hex), or `[]` when no key is cached yet.
   */
  async listPeerIdentities(peer: BareJID): Promise<PeerIdentity[]> {
    const fp = this.getPeerFingerprint(peer)
    if (!fp) return []
    return [{ id: fp, fingerprint: fp, trust: await this.evaluatePeerTrust(peer) }]
  }

  /**
   * Per-identity trust write (E2EEPlugin trait). `'verified'` pins the
   * verified marker to the peer's CURRENT primary fingerprint;
   * `'untrusted'` revokes verification back to TOFU (OpenPGP is single-key,
   * so "revoke" retracts the out-of-band confirmation rather than persisting
   * a distrust — see the design spec). No-ops when no key is cached, or when
   * a non-empty `id` no longer matches the current fingerprint (the identity
   * the caller compared out-of-band has since rotated).
   */
  async setIdentityTrust(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void> {
    const cur = this.getPeerFingerprint(peer)
    if (!cur) return
    if (id && !fingerprintsEqual(id, cur)) return
    if (decision === 'verified') {
      this.hostStores.verifiedPeers.setVerified(peer, cur)
    } else {
      this.hostStores.verifiedPeers.clearVerified(peer)
    }
  }
```

- [ ] **Step 5: Run the tests, verify they pass.**

Run: `cd packages/openpgp-plugin && npx vitest run src/OpenPGPPluginBase.trait.test.ts`
Expected: PASS (8/8).

- [ ] **Step 6: Typecheck the package and commit.**

Run: `npm run typecheck` (root; covers all workspaces).
Expected: clean.

```bash
git add packages/openpgp-plugin/src/OpenPGPPluginBase.ts packages/openpgp-plugin/src/OpenPGPPluginBase.trait.test.ts packages/openpgp-plugin/src/testSupport/baseHarness.ts
git commit --no-gpg-sign -m "feat(openpgp-plugin): implement listPeerIdentities/setIdentityTrust trait methods"
```

---

### Task 2: Generalize `SecurityTab` (`OmemoDeviceList` → `PeerIdentityList`)

**Files:**
- Modify: `apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`
- Modify: `apps/fluux/src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx` (rename `omemo` → `identities` in props; behavior assertions unchanged)
- Modify: `apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx` (rewrite the SecurityTab section for the shared list; leave `getGlance`/`ChatHeader` sections verbatim)

**Interfaces:**
- Consumes: `PeerIdentity` from `@fluux/sdk`; the Task-1 `listPeerIdentities`/`setIdentityTrust` shapes (via the handle built in Task 4).
- Produces: a protocol-neutral `identities` prop consumed by `ContactSecurityDetail`/`ContactProfileView` (Task 4):
  ```ts
  identities?: {
    listPeerIdentities: (peer: string) => Promise<PeerIdentity[]>
    onVerifyDevice: (identity: PeerIdentity) => void
    onRevokeDevice: (identity: PeerIdentity) => Promise<void>
    reloadKey?: number
    /** Protocol-appropriate row label. OMEMO: `(id) => t('…deviceLabel',{id})`; OpenPGP: `() => t('…openpgpKeyLabel')`. */
    rowLabel: (identity: PeerIdentity) => string
    /** OpenPGP sets this to keep its "disable for contact" affordance; OMEMO leaves it unset. */
    showDisableButton?: boolean
    onDisableEncryption?: () => void
  } | null
  ```

**Design decisions baked in (flag to reviewer + design owner):**
- The per-identity list is now capability-gated (`identities` present) rather than `protocolId === 'omemo:2'`-gated. OpenPGP flows through the same list.
- Rows carry a **protocol-appropriate label** via `rowLabel` (OMEMO "Device {id}", OpenPGP "OpenPGP key") so a single OpenPGP key isn't mislabeled as a numbered device. `PeerIdentity` (SDK) is unchanged; the label is an app-side handle concern.
- `data-testid` stays `omemo-verify-…`/`omemo-revoke-…` **for now** to avoid churning OMEMO tests in this task; rename to `identity-verify-…` is a trivial follow-up. (Alternatively rename here and update `SecurityTab.omemo.test.tsx` — implementer's choice, but keep it consistent.)
- **Disable-encryption button:** preserve current per-protocol behavior — OpenPGP shows "disable for contact"; OMEMO does not. Carried by `showDisableButton`/`onDisableEncryption` on the handle (OpenPGP sets it, OMEMO leaves it unset) so no OMEMO behavior change.

- [ ] **Step 1: Write/adjust the failing tests.**

In `SecurityTab.omemo.test.tsx`, rename the prop `omemo={omemo}` → `identities={identities}` in every render and add a `rowLabel` to `makeOmemo`:
```ts
function makeOmemo(list: PeerIdentity[]) {
  return {
    listPeerIdentities: vi.fn().mockResolvedValue(list),
    onVerifyDevice: vi.fn(),
    onRevokeDevice: vi.fn().mockResolvedValue(undefined),
    rowLabel: (id: PeerIdentity) => `Device ${id.id}`,
  }
}
```
All behavioral assertions (badges, disabled verify, error/retry, danger cue) stay identical.

In `openpgpTrustRendering.regression.test.tsx`, replace the three SecurityTab OpenPGP `it(...)` blocks (`verified`, `tofu`, `tofu firstSeen`) with tests that render the shared list for an OpenPGP identity handle and assert: verified → `ShieldCheck` + `text-fluux-encryption` badge + revoke button present; tofu → plain `Shield` + `text-fluux-muted` + verify button present. Keep the `getGlance` and `ChatHeader` `it(...)` blocks **exactly as-is** (they exercise the untouched hook-output path).

```ts
function makeOpenpgp(list: PeerIdentity[]) {
  return {
    listPeerIdentities: vi.fn().mockResolvedValue(list),
    onVerifyDevice: vi.fn(),
    onRevokeDevice: vi.fn().mockResolvedValue(undefined),
    rowLabel: () => 'OpenPGP key',
  }
}

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
})
```

- [ ] **Step 2: Run tests, verify failure.**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx src/e2ee/openpgpTrustRendering.regression.test.tsx`
Expected: FAIL (`identities` prop unknown / `PeerIdentityList` not rendered).

- [ ] **Step 3: Implement the generalization in `SecurityTab.tsx`.**

1. Rename the `omemo?: {…}` prop to `identities?: {…}` with the shape in Interfaces above (add `rowLabel`, optional `showDisableButton`/`onDisableEncryption`). Update the destructure and `SecurityTabProps`.
2. Replace the two `state.kind === 'encrypted' && …` blocks (lines ~123-187) with:
   ```tsx
   {state.kind === 'encrypted' && identities && peerJid && (
     <PeerIdentityList peerJid={peerJid} identities={identities} />
   )}
   {state.kind === 'encrypted' && !(identities && peerJid) && (
     <> {/* defensive single-fingerprint fallback — unchanged bespoke panel */} </>
   )}
   ```
   Keep the bespoke single-fingerprint block as the fallback branch (unchanged) so a conversation without an `identities` handle still renders.
3. Rename `OmemoDeviceList` → `PeerIdentityList`, retype its `omemo` param → `identities: NonNullable<SecurityTabProps['identities']>`, and:
   - Replace the device label `t('contacts.encryption.omemo.deviceLabel', { id: id.id })` with `identities.rowLabel(id)`.
   - Replace the `contacts.encryption.omemo.*` string keys (`summary`, `loading`, `loadError`, `retry`, `noKeyYet`, `verify`, `revoke`) with `contacts.encryption.identity.*` (Task 3 adds these).
   - After the list, if `identities.showDisableButton`, render the "disable for contact" button calling `identities.onDisableEncryption?.()` (preserves OpenPGP's affordance).

- [ ] **Step 4: Run tests, verify pass.**

Run: `cd apps/fluux && npx vitest run src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx src/e2ee/openpgpTrustRendering.regression.test.tsx`
Expected: PASS. (i18n keys resolve to raw keys in tests until Task 3; assertions here key off classes/testids/`trustLabel` keys, not the renamed copy — verify the two files don't assert on `contacts.encryption.omemo.summary` etc. If any do, update them to `identity.*`.)

- [ ] **Step 5: Typecheck + commit.**

Run: `npm run typecheck`
Expected: clean (will fail in `ContactSecurityDetail`/`ContactProfileView` if they still pass `omemo=` — that's expected; those are Task 4. If typecheck must be green per-commit, do Task 4 before committing, or temporarily keep the `omemo` prop as a deprecated alias. Prefer sequencing Task 4 immediately.)

```bash
git add apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx apps/fluux/src/components/contact-profile/tabs/SecurityTab.omemo.test.tsx apps/fluux/src/e2ee/openpgpTrustRendering.regression.test.tsx
git commit --no-gpg-sign -m "refactor(e2ee): generalize SecurityTab OmemoDeviceList into protocol-neutral PeerIdentityList"
```

> Note: Tasks 2 and 4 are tightly coupled through the prop rename. If the reviewer prefers a single green commit, implement Task 4's `SecurityTab`-facing pieces together and commit once. Keep the two review packages separate regardless.

---

### Task 3: Protocol-neutral i18n keys (`contacts.encryption.identity.*`) across 33 locales

**Files:**
- Modify: `apps/fluux/public/locales/*/translation.json` (all 33)

**Interfaces:**
- Consumes: nothing.
- Produces: the `contacts.encryption.identity.*` key set consumed by `PeerIdentityList` (Task 2).

The new keys (English values; the OMEMO copy generalized to be protocol-neutral, plus the OpenPGP row label):
```json
"identity": {
  "summary": "{{verified}} of {{count}} verified",
  "deviceLabel": "Device {{id}}",
  "openpgpKeyLabel": "OpenPGP key",
  "loading": "Loading keys…",
  "loadError": "Couldn't load keys",
  "retry": "Retry",
  "noKeyYet": "No key published yet",
  "verify": "Verify",
  "revoke": "Revoke"
}
```

- [ ] **Step 1: Add the keys to the English locale.** Insert `identity` under `contacts.encryption` in `apps/fluux/public/locales/en/translation.json`, adjacent to the existing `omemo` block. Use the surgical edit: read → `JSON.parse` → set `data.contacts.encryption.identity = {…}` → `fs.writeFileSync(path, JSON.stringify(data, null, 4) + "\n")`.

- [ ] **Step 2: Translate into the other 32 locales.** Claude translates all locales (per project workflow). For each `apps/fluux/public/locales/<lang>/translation.json`, add the same `identity` block with translated values (no em-dash connectors; keep `{{id}}`/`{{count}}`/`{{verified}}` placeholders verbatim). Preserve each file's key ordering by inserting adjacent to its existing `omemo` block; write with `JSON.stringify(data, null, 4) + "\n"`.

- [ ] **Step 3: Keep or retire the old `omemo` keys.** Leave `contacts.encryption.omemo.*` in place for this phase (still referenced by any not-yet-migrated copy and by `SecurityTab.omemo.test.tsx` comments); a dead-key sweep is a trivial follow-up once nothing references them. Do **not** delete in Phase A.

- [ ] **Step 4: If the test i18n subset asserts any renamed label, mirror it.** If `apps/fluux/src/test-setup.ts` supplies real translations for asserted keys (e.g. a `verify`/`verifyButton` string the regression net asserts), add the corresponding `contacts.encryption.identity.*` entries to that subset so the tests keep asserting real strings, not raw keys.

- [ ] **Step 5: Typecheck + a JSON validity check + commit.**

Run: `node -e "const fs=require('fs');for(const d of fs.readdirSync('apps/fluux/public/locales')){JSON.parse(fs.readFileSync('apps/fluux/public/locales/'+d+'/translation.json','utf8'))}console.log('all locales parse')"`
Expected: `all locales parse`.

```bash
git add apps/fluux/public/locales apps/fluux/src/test-setup.ts
git commit --no-gpg-sign -m "i18n(e2ee): add protocol-neutral contacts.encryption.identity.* keys (33 locales)"
```

---

### Task 4: Wire OpenPGP into the shared per-identity handle (`ContactProfileView` + `ContactSecurityDetail`)

**Files:**
- Modify: `apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx` (prop `omemo` → `identities`)
- Modify: `apps/fluux/src/components/ContactProfileView.tsx` (build the protocol-neutral `identities` handle for OpenPGP and OMEMO; wire OpenPGP verify/revoke through `setIdentityTrust`)
- Test: `apps/fluux/src/components/ContactProfileView.test.tsx` if present (else add a focused test asserting OpenPGP builds a non-null `identities` handle and verify calls `setIdentityTrust('verified')`)

**Interfaces:**
- Consumes: Task-1 `listPeerIdentities`/`setIdentityTrust` on the openpgp plugin; Task-2 `identities` prop shape.
- Produces: nothing downstream (leaf wiring).

- [ ] **Step 1: `ContactSecurityDetail.tsx` — rename the passthrough.** Change `omemo?: React.ComponentProps<typeof SecurityTab>['omemo']` → `identities?: React.ComponentProps<typeof SecurityTab>['identities']`, the destructure, and the `<SecurityTab … omemo={omemo} />` → `identities={identities}`.

- [ ] **Step 2: Write the failing test (ContactProfileView).**

Assert that for an OpenPGP-encrypted conversation the built handle is non-null and that verify routes through `setIdentityTrust`. Mirror the existing ContactProfileView test harness (mock `useXMPPContext`/`client.e2ee.getPlugin`). If no such test file exists, create `ContactProfileView.identities.test.tsx` with a minimal harness. Assert:
- `getPlugin('openpgp')` returning a stub with `listPeerIdentities`/`setIdentityTrust`/`getOwnFingerprint` yields a non-null `identities` handle passed to `ContactSecurityDetail`.
- Invoking the handle's `onVerifyDevice` then confirming the dialog calls `setIdentityTrust(jid, id, 'verified')`.
- `onRevokeDevice` calls `setIdentityTrust(jid, id, 'untrusted')`.

- [ ] **Step 3: Generalize the handle construction.**

Replace the OMEMO-specific `omemoPlugin`/`isOmemoConversation`/`omemoProp` (lines ~74-108) with a protocol-neutral resolution:
```tsx
// Resolve the plugin driving THIS conversation and, if it exposes the
// per-identity trait, build the shared identities handle. OMEMO and OpenPGP
// both flow through this now.
const activeProtocol =
  encryptionState.kind === 'encrypted' ? (encryptionState.protocolId ?? 'openpgp') : null
const identityPlugin = activeProtocol
  ? (client.e2ee?.getPlugin(activeProtocol) as {
      listPeerIdentities?: (peer: string) => Promise<PeerIdentity[]>
      getOwnFingerprint: () => string | null | Promise<string | null>
      setIdentityTrust?: (peer: string, id: string, decision: 'verified' | 'untrusted') => Promise<void>
    } | null | undefined)
  : null

const [verifyDevice, setVerifyDevice] = useState<PeerIdentity | null>(null)
const [dialogOwnFp, setDialogOwnFp] = useState<string | null>(null)
const [identityReloadKey, setIdentityReloadKey] = useState(0)

const identitiesProp = useMemo(() => {
  if (!identityPlugin?.listPeerIdentities || !identityPlugin.setIdentityTrust) return null
  const setTrust = identityPlugin.setIdentityTrust.bind(identityPlugin)
  const isOmemo = activeProtocol === 'omemo:2'
  return {
    listPeerIdentities: identityPlugin.listPeerIdentities.bind(identityPlugin),
    rowLabel: (id: PeerIdentity) =>
      isOmemo ? t('contacts.encryption.identity.deviceLabel', { id: id.id })
              : t('contacts.encryption.identity.openpgpKeyLabel'),
    onVerifyDevice: (identity: PeerIdentity) => {
      void Promise.resolve(identityPlugin.getOwnFingerprint()).then((fp) => {
        setDialogOwnFp(fp)
        setVerifyDevice(identity)
      })
    },
    onRevokeDevice: async (identity: PeerIdentity) => {
      await setTrust(contact.jid, identity.id, 'untrusted')
      setIdentityReloadKey((n) => n + 1)
    },
    reloadKey: identityReloadKey,
    // OpenPGP keeps its "disable for contact" affordance; OMEMO unchanged (unset).
    showDisableButton: activeProtocol === 'openpgp',
    onDisableEncryption: handleDisableEncryption,
  }
}, [identityPlugin, activeProtocol, contact.jid, identityReloadKey, t, handleDisableEncryption])
```
Update the `<ContactSecurityDetail … omemo={omemoProp} />` → `identities={identitiesProp}`. Update the shared verify dialog (lines ~340-356) to use `dialogOwnFp` and the resolved `setTrust` for both protocols; delete the now-redundant OpenPGP-only `setVerified(...)` path at line ~333 (verification now goes through `setIdentityTrust('verified')`). Keep `VerifyPeerDialog`'s `peerFingerprint`/`ownFingerprint`/`alreadyVerified` wiring.

> Note the intentional behavior change for OpenPGP: verification now writes via `plugin.setIdentityTrust` (which calls `hostStores.verifiedPeers.setVerified` under the hood) instead of the component calling `useVerifiedPeerKeysStore.setVerified` directly. Net effect on stored data is identical (same store, same fingerprint), but the crypto/trust decision now lives behind the plugin — exactly the asymmetry this slice retires. Assert this equivalence in the Step-2 test.

- [ ] **Step 4: Run tests, verify pass.**

Run: `cd apps/fluux && npx vitest run src/components/ContactProfileView*.test.tsx src/components/contact-profile`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit.**

Run: `npm run typecheck`
Expected: clean across all workspaces.

```bash
git add apps/fluux/src/components/ContactProfileView.tsx apps/fluux/src/components/contact-profile/ContactSecurityDetail.tsx apps/fluux/src/components/ContactProfileView*.test.tsx
git commit --no-gpg-sign -m "feat(e2ee): render OpenPGP through the shared per-identity verify UI"
```

---

### Task 5: Full-suite parity gate + regression-net confirmation

**Files:** none (verification only).

- [ ] **Step 1: Root typecheck.**

Run: `npm run typecheck`
Expected: clean (5 workspaces).

- [ ] **Step 2: Run the OpenPGP-plugin package suite.**

Run: `cd packages/openpgp-plugin && npx vitest run`
Expected: all green, no stderr.

- [ ] **Step 3: Run the full app suite.**

Run: `cd apps/fluux && npx vitest run`
Expected: all green, no stderr. Confirm specifically that the `getGlance` and `ChatHeader` sections of `openpgpTrustRendering.regression.test.tsx` pass **unchanged** (proves the composer/header/glance path was not disturbed), and that `SecurityTab.omemo.test.tsx` passes (proves OMEMO's list behavior is preserved through the rename).

- [ ] **Step 4: Grep-guard: no lingering `protocolId === 'omemo:2'` gate on the per-identity UI.**

Run: `grep -rn "omemo:2" apps/fluux/src/components/contact-profile apps/fluux/src/components/ContactProfileView.tsx`
Expected: no per-identity-list gating remains (the only `omemo:2` references should be the protocol-id label logic in the handle, not a UI gate).

- [ ] **Step 5: Update the ledger / no commit needed.** Record Phase A complete-green in the SDD ledger.

---

## Non-Autonomous Gates (after this plan)

1. **Manual E2E** (`tauri:dev` / web): open an OpenPGP 1:1 → Security details → the shared per-identity list renders one "OpenPGP key" row; Verify → fingerprint compare → badge flips to verified; Revoke → returns to TOFU and messaging continues; confirm OMEMO's list still verifies/revokes per device.
2. **Re-sign** the Phase A commits from RustRover before the branch merges (sandbox ssh-agent broken).

## Deferred to Phase B (its own spec + plan)

Move verified data into `PluginStorage` (`verifiedKeys.ts`), in-memory cache + internal notify, rework `trustStateIntegrity` snapshot source, rewire the remote verification-sync publish/apply, one-time localStorage→PluginStorage migration, delete the `hostStores.verifiedPeers` group + `verifiedPeerKeysStore`. Also optional: hook unification (route `useConversationEncryptionState` OpenPGP trust through `getPeerTrust`) — deferred because it is async-vs-sync structural churn with no consumer-visible change.
