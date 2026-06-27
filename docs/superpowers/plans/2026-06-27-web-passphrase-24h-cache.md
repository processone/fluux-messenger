# Web Passphrase 24h Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let web users opt in (via a checkbox in the unlock dialog) to remembering their OpenPGP key passphrase on-device for 24 hours, stored encrypted under a non-extractable WebCrypto key.

**Architecture:** A new best-effort `webPassphraseCache` module encrypts the passphrase with a non-extractable AES-GCM `CryptoKey` and stores it (plus IV, ciphertext, expiry) in a dedicated IndexedDB database, keyed per bare JID. The unlock dialog writes the cache on confirm when the box is checked; the app's connect handler reads it to silently unlock; logout clears it.

**Tech Stack:** TypeScript, React, WebCrypto (`crypto.subtle`), IndexedDB, Vitest + `fake-indexeddb`, i18next.

**Reference spec:** [docs/superpowers/specs/2026-06-27-web-passphrase-24h-cache-design.md](../specs/2026-06-27-web-passphrase-24h-cache-design.md)

## Global Constraints

- Web platform only. Desktop (Tauri) is untouched; the unlock dialog and this cache never run there (`isTauri()` guards the UI; the connect handler already guards `!isTauri`).
- The raw passphrase is **never** persisted in cleartext. Only ciphertext + a non-extractable `CryptoKey` (`extractable: false`) are stored. Only the boolean *preference* goes to localStorage.
- Expiry is fixed 24h from caching: `expiresAt = Date.now() + 24 * 60 * 60 * 1000`. No sliding renewal.
- Checkbox shows in **unlock mode only** (not setup/restore).
- All cache operations are best-effort: failures must be swallowed and must never block login or logout.
- New i18n keys require a genuine translation in every locale file under `apps/fluux/src/i18n/locales/` (33 `.json` files). Do not copy English into other locales. No em-dashes (—) or en-dashes (–) in any user-facing string. `apps/fluux/src/i18n/i18n.test.ts` fails if any locale lacks a key.
- Run app tests from `apps/fluux` (the root vitest config lacks the `@` alias).

---

### Task 1: `webPassphraseCache` storage module

**Files:**
- Create: `apps/fluux/src/e2ee/webPassphraseCache.ts`
- Test: `apps/fluux/src/e2ee/webPassphraseCache.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; uses global `crypto`, `indexedDB`, `localStorage`).
- Produces:
  - `cachePassphrase(jid: string, passphrase: string, ttlMs?: number): Promise<void>`
  - `loadCachedPassphrase(jid: string): Promise<string | null>`
  - `clearCachedPassphrase(jid: string): Promise<void>`
  - `clearAllCachedPassphrases(): Promise<void>`
  - `getRememberPassphrasePreference(): boolean`
  - `setRememberPassphrasePreference(value: boolean): void`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/e2ee/webPassphraseCache.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  cachePassphrase,
  loadCachedPassphrase,
  clearCachedPassphrase,
  clearAllCachedPassphrases,
  getRememberPassphrasePreference,
  setRememberPassphrasePreference,
} from './webPassphraseCache'

// Fresh in-memory IndexedDB per test so records don't leak across tests.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
})
afterEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
})

const JID = 'alice@example.com'
const PASSPHRASE = 'correct horse battery staple'

describe('webPassphraseCache', () => {
  it('round-trips a passphrase through cache / load', async () => {
    await cachePassphrase(JID, PASSPHRASE)
    expect(await loadCachedPassphrase(JID)).toBe(PASSPHRASE)
  })

  it('returns null for an unknown jid', async () => {
    expect(await loadCachedPassphrase('nobody@example.com')).toBeNull()
  })

  it('expires and deletes a record past its ttl', async () => {
    await cachePassphrase(JID, PASSPHRASE, -1) // already expired
    expect(await loadCachedPassphrase(JID)).toBeNull()
    // second load proves the expired record was deleted, not just skipped
    expect(await loadCachedPassphrase(JID)).toBeNull()
  })

  it('clearCachedPassphrase removes one account', async () => {
    await cachePassphrase(JID, PASSPHRASE)
    await cachePassphrase('bob@example.com', 'other-pass')
    await clearCachedPassphrase(JID)
    expect(await loadCachedPassphrase(JID)).toBeNull()
    expect(await loadCachedPassphrase('bob@example.com')).toBe('other-pass')
  })

  it('clearAllCachedPassphrases removes every account', async () => {
    await cachePassphrase(JID, PASSPHRASE)
    await cachePassphrase('bob@example.com', 'other-pass')
    await clearAllCachedPassphrases()
    expect(await loadCachedPassphrase(JID)).toBeNull()
    expect(await loadCachedPassphrase('bob@example.com')).toBeNull()
  })

  it('never stores the passphrase in cleartext', async () => {
    await cachePassphrase(JID, PASSPHRASE)
    const raw = await rawRecord(JID)
    expect(raw).not.toBeNull()
    const bytes = new Uint8Array(raw!.ciphertext as ArrayBuffer)
    const asLatin1 = String.fromCharCode(...bytes)
    expect(asLatin1).not.toContain(PASSPHRASE)
    // the stored wrap key must be non-extractable
    expect((raw!.wrapKey as CryptoKey).extractable).toBe(false)
  })

  it('preference defaults to false and round-trips', () => {
    expect(getRememberPassphrasePreference()).toBe(false)
    setRememberPassphrasePreference(true)
    expect(getRememberPassphrasePreference()).toBe(true)
    setRememberPassphrasePreference(false)
    expect(getRememberPassphrasePreference()).toBe(false)
  })
})

// Read the raw stored record directly, bypassing decrypt, to inspect bytes.
function rawRecord(jid: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('fluux-e2ee-passphrase-cache', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('cache', { keyPath: 'jid' })
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('cache', 'readonly')
      const req = tx.objectStore('cache').get(jid)
      req.onsuccess = () => resolve((req.result as Record<string, unknown>) ?? null)
      req.onerror = () => reject(req.error)
    }
    open.onerror = () => reject(open.error)
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/webPassphraseCache.test.ts`
Expected: FAIL — cannot resolve `./webPassphraseCache` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/fluux/src/e2ee/webPassphraseCache.ts`:

```typescript
/**
 * Optional 24h on-device cache for the web OpenPGP session passphrase.
 *
 * The passphrase is encrypted with a NON-EXTRACTABLE AES-GCM CryptoKey and
 * stored (with its IV, ciphertext, and a fixed expiry) in a dedicated
 * IndexedDB database, keyed per bare JID. The CryptoKey object persists via
 * structured clone, but its raw bytes cannot be read back by JS, so a passive
 * storage dump yields only ciphertext it cannot decrypt. A live-JS (XSS)
 * attacker on the page is NOT mitigated; the fixed expiry bounds exposure.
 *
 * Every operation is best-effort: failures are swallowed so the cache can
 * never block login or logout. The plaintext passphrase still lives only in
 * module memory (see webPassphraseStore.ts) once unlocked; this cache only
 * shortcuts re-entry across page reloads within the expiry window.
 *
 * Only the user's checkbox PREFERENCE (a boolean) is stored in localStorage,
 * never the passphrase.
 */

const DB_NAME = 'fluux-e2ee-passphrase-cache'
const STORE_NAME = 'cache'
const DB_VERSION = 1
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const REMEMBER_PREF_KEY = 'fluux:openpgp:remember-passphrase'

interface CacheRecord {
  jid: string
  wrapKey: CryptoKey
  iv: Uint8Array
  ciphertext: ArrayBuffer
  expiresAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'jid' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function readRecord(jid: string): Promise<CacheRecord | null> {
  const db = await openDb()
  try {
    return await new Promise<CacheRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(jid)
      req.onsuccess = () => resolve((req.result as CacheRecord | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function writeRecord(record: CacheRecord): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function deleteRecord(jid: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(jid)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/** Encrypt and cache the passphrase for `jid`, expiring `ttlMs` from now. */
export async function cachePassphrase(
  jid: string,
  passphrase: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
  try {
    const wrapKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt'],
    )
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrapKey,
      new TextEncoder().encode(passphrase),
    )
    await writeRecord({ jid, wrapKey, iv, ciphertext, expiresAt: Date.now() + ttlMs })
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: cache failed', err)
  }
}

/** Load and decrypt the cached passphrase for `jid`, or null if absent/expired/invalid. */
export async function loadCachedPassphrase(jid: string): Promise<string | null> {
  try {
    const record = await readRecord(jid)
    if (!record) return null
    if (Date.now() > record.expiresAt) {
      await deleteRecord(jid)
      return null
    }
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      record.wrapKey,
      record.ciphertext,
    )
    return new TextDecoder().decode(plain)
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: load failed', err)
    await deleteRecord(jid).catch(() => {})
    return null
  }
}

/** Remove the cached passphrase for one account. */
export async function clearCachedPassphrase(jid: string): Promise<void> {
  try {
    await deleteRecord(jid)
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: clear failed', err)
  }
}

/** Remove all cached passphrases (full local-data wipe). */
export async function clearAllCachedPassphrases(): Promise<void> {
  try {
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: clearAll failed', err)
  }
}

/** Whether the user last opted to remember the passphrase. Defaults to false. */
export function getRememberPassphrasePreference(): boolean {
  try {
    return localStorage.getItem(REMEMBER_PREF_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist the user's remember-passphrase checkbox choice (boolean only). */
export function setRememberPassphrasePreference(value: boolean): void {
  try {
    localStorage.setItem(REMEMBER_PREF_KEY, value ? 'true' : 'false')
  } catch {
    // ignore storage failures
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/webPassphraseCache.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/e2ee/webPassphraseCache.ts apps/fluux/src/e2ee/webPassphraseCache.test.ts
git commit -m "feat(e2ee): add encrypted 24h web passphrase cache module"
```

---

### Task 2: i18n keys for the checkbox

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` (add two keys in the `settings.encryption` object, near `unlockAction`)
- Modify: the other 32 locale files under `apps/fluux/src/i18n/locales/` (same two keys, genuine per-language translations)

**Interfaces:**
- Consumes: nothing.
- Produces: i18n keys `settings.encryption.rememberPassphrase` and `settings.encryption.rememberPassphraseHint`, used by Task 3.

- [ ] **Step 1: Add the English source strings**

In `apps/fluux/src/i18n/locales/en.json`, inside the `settings.encryption` object (the one containing `"unlockAction": "Unlock"`), add:

```json
"rememberPassphrase": "Keep my passphrase on this device for 24 hours",
"rememberPassphraseHint": "Stored encrypted. Anyone with access to this device could use it until it expires.",
```

- [ ] **Step 2: Add genuine translations to all 32 other locales**

For each file in `apps/fluux/src/i18n/locales/` other than `en.json` (`ar, be, bg, ca, cs, da, de, el, es, ...` — all 32), add the same two keys inside that file's `settings.encryption` object, each with a real translation in that language. Do NOT copy the English text. Do NOT use em-dashes or en-dashes. Match the tone of the sibling keys already in `settings.encryption` (e.g. `unlockAction`, `restorePassphraseLabel`).

- [ ] **Step 3: Run the i18n test to verify completeness**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS. (The test fails if any locale is missing either new key; if it fails, it names the locale and key to fix.)

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n: add remember-passphrase checkbox strings (all locales)"
```

---

### Task 3: Unlock dialog checkbox + cache-on-confirm

**Files:**
- Modify: `apps/fluux/src/components/UnlockEncryptionDialog.tsx`
- Test: `apps/fluux/src/components/UnlockEncryptionDialog.test.tsx` (create)

**Interfaces:**
- Consumes: `cachePassphrase`, `clearCachedPassphrase`, `getRememberPassphrasePreference`, `setRememberPassphrasePreference` (Task 1); `getBareJid` from `@fluux/sdk`; `client.getJid()`; i18n keys (Task 2); `isTauri` from `@/utils/tauri`.
- Produces: a checkbox UI that writes/clears the cache on a successful unlock.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/UnlockEncryptionDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UnlockEncryptionDialog } from './UnlockEncryptionDialog'

const cachePassphrase = vi.fn()
const clearCachedPassphrase = vi.fn()
vi.mock('@/e2ee/webPassphraseCache', () => ({
  cachePassphrase: (...a: unknown[]) => cachePassphrase(...a),
  clearCachedPassphrase: (...a: unknown[]) => clearCachedPassphrase(...a),
  getRememberPassphrasePreference: () => false,
  setRememberPassphrasePreference: vi.fn(),
}))

// i18n: return the key so we can assert by stable text fragments.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

function makeClient(unlock: ReturnType<typeof vi.fn>) {
  return {
    getJid: () => 'alice@example.com/web',
    e2ee: {
      getPlugin: () => ({
        // no hasNoLocalKey => dialog resolves to 'unlock' mode
        unlock,
      }),
    },
  } as unknown as Parameters<typeof UnlockEncryptionDialog>[0]['client']
}

beforeEach(() => {
  cachePassphrase.mockReset()
  clearCachedPassphrase.mockReset()
})

describe('UnlockEncryptionDialog remember checkbox', () => {
  it('shows the checkbox in unlock mode', async () => {
    render(<UnlockEncryptionDialog client={makeClient(vi.fn())} onClose={vi.fn()} />)
    expect(await screen.findByText('settings.encryption.rememberPassphrase')).toBeTruthy()
  })

  it('caches the passphrase when the box is checked on confirm', async () => {
    const unlock = vi.fn().mockResolvedValue({ recovered: false })
    const onClose = vi.fn()
    render(<UnlockEncryptionDialog client={makeClient(unlock)} onClose={onClose} />)

    fireEvent.change(await screen.findByPlaceholderText('settings.encryption.restorePassphrasePlaceholder'), {
      target: { value: 'my-passphrase' },
    })
    fireEvent.click(screen.getByLabelText('settings.encryption.rememberPassphrase'))
    fireEvent.click(screen.getByText('settings.encryption.unlockAction'))

    await waitFor(() => expect(unlock).toHaveBeenCalledWith('my-passphrase'))
    expect(cachePassphrase).toHaveBeenCalledWith('alice@example.com', 'my-passphrase')
    expect(clearCachedPassphrase).not.toHaveBeenCalled()
  })

  it('clears any prior cache when confirming with the box unchecked', async () => {
    const unlock = vi.fn().mockResolvedValue({ recovered: false })
    render(<UnlockEncryptionDialog client={makeClient(unlock)} onClose={vi.fn()} />)

    fireEvent.change(await screen.findByPlaceholderText('settings.encryption.restorePassphrasePlaceholder'), {
      target: { value: 'my-passphrase' },
    })
    fireEvent.click(screen.getByText('settings.encryption.unlockAction'))

    await waitFor(() => expect(clearCachedPassphrase).toHaveBeenCalledWith('alice@example.com'))
    expect(cachePassphrase).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/UnlockEncryptionDialog.test.tsx`
Expected: FAIL — the checkbox text/label is not found (UI not added yet).

- [ ] **Step 3: Add imports**

In `apps/fluux/src/components/UnlockEncryptionDialog.tsx`, add to the imports at the top (after the existing imports, lines 1-7):

```tsx
import { getBareJid } from '@fluux/sdk'
import { isTauri } from '@/utils/tauri'
import {
  cachePassphrase,
  clearCachedPassphrase,
  getRememberPassphrasePreference,
  setRememberPassphrasePreference,
} from '@/e2ee/webPassphraseCache'
```

- [ ] **Step 4: Add checkbox state**

In `UnlockEncryptionDialog`, after the existing `const [confirmPassphrase, setConfirmPassphrase] = useState('')` (line 34), add:

```tsx
  const [rememberPassphrase, setRememberPassphrase] = useState(getRememberPassphrasePreference)
```

- [ ] **Step 5: Cache on successful unlock**

In `handleConfirm` (line 86), replace the success block. The current code is:

```tsx
      const result = await plugin.unlock(passphrase)
      // unlock() signals key-unlocked itself now — happy path directly, or via
      // restoreSecretKey → doInstallKey on recovery — so the SDK re-runs
      // deferred decrypts without an explicit notifyE2EEKeyUnlocked() here.
      if (result?.recovered) {
        setRecovered(true)
        setTimeout(() => onClose(true), 1500)
        return
      }
      onClose(true)
```

Replace it with:

```tsx
      const result = await plugin.unlock(passphrase)
      // unlock() signals key-unlocked itself now — happy path directly, or via
      // restoreSecretKey → doInstallKey on recovery — so the SDK re-runs
      // deferred decrypts without an explicit notifyE2EEKeyUnlocked() here.
      // Persist the remember-passphrase choice and (un)cache accordingly. Only
      // meaningful on web; on Tauri the checkbox is not rendered and the jid
      // guard below makes this a no-op anyway.
      if (mode === 'unlock' && !isTauri()) {
        const full = client.getJid()
        const bareJid = full ? getBareJid(full) : null
        setRememberPassphrasePreference(rememberPassphrase)
        if (bareJid) {
          if (rememberPassphrase) await cachePassphrase(bareJid, passphrase)
          else await clearCachedPassphrase(bareJid)
        }
      }
      if (result?.recovered) {
        setRecovered(true)
        setTimeout(() => onClose(true), 1500)
        return
      }
      onClose(true)
```

Then add `rememberPassphrase` to the `handleConfirm` `useCallback` dependency array (line 131). The current array is:

```tsx
  }, [passphrase, confirmPassphrase, mode, client, onClose, t])
```

Change it to:

```tsx
  }, [passphrase, confirmPassphrase, mode, client, onClose, t, rememberPassphrase])
```

- [ ] **Step 6: Render the checkbox**

In the scrollable body, immediately after the `mode === 'setup'` confirm-field block (the closing `)}` at line 253, before the `{recovered && (` block at line 255), insert:

```tsx
          {mode === 'unlock' && !isTauri() && (
            <label className="flex items-start gap-2 mb-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberPassphrase}
                disabled={isWorking || loading}
                onChange={(e) => setRememberPassphrase(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-sm text-fluux-text">
                {t('settings.encryption.rememberPassphrase')}
                <span className="block text-xs text-fluux-muted">
                  {t('settings.encryption.rememberPassphraseHint')}
                </span>
              </span>
            </label>
          )}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/UnlockEncryptionDialog.test.tsx`
Expected: PASS (3 tests).

If `@testing-library/react` is not already a dependency, confirm with `grep '@testing-library/react' apps/fluux/package.json`; it is used by existing component tests, so it should resolve.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/UnlockEncryptionDialog.tsx apps/fluux/src/components/UnlockEncryptionDialog.test.tsx
git commit -m "feat(e2ee): remember-passphrase checkbox in web unlock dialog"
```

---

### Task 4: Silent restore on connect

**Files:**
- Modify: `apps/fluux/src/App.tsx` (the connect handler, around lines 278-281)

**Interfaces:**
- Consumes: `loadCachedPassphrase`, `clearCachedPassphrase` (Task 1); `accountJid` and `client` already in scope in the handler.
- Produces: silent unlock at connect time when a valid cached passphrase exists (dialog stays closed).

- [ ] **Step 1: Add the import**

In `apps/fluux/src/App.tsx`, near the existing `import { isKeyLocked } from ...` (the webPassphraseStore import on line 6), add:

```tsx
import { loadCachedPassphrase, clearCachedPassphrase } from '@/e2ee/webPassphraseCache'
```

- [ ] **Step 2: Replace the unlock-dialog trigger with a restore attempt**

The current block (lines 278-281) reads:

```tsx
        // Web-only: a stored-but-locked key needs the session passphrase.
        if (!isTauri && isKeyLocked()) {
          openWebUnlockDialog()
        }
```

Replace it with:

```tsx
        // Web-only: a stored-but-locked key needs the session passphrase.
        // Try the opt-in 24h cache first so the user skips re-entry; fall back
        // to the interactive dialog on miss or any failure (e.g. rotated key).
        if (!isTauri && isKeyLocked()) {
          const cached = accountJid ? await loadCachedPassphrase(accountJid) : null
          if (cached) {
            const unlockPlugin = client.e2ee?.getPlugin('openpgp') as
              | { unlock?: (pp: string) => Promise<{ recovered: boolean }> }
              | null
              | undefined
            try {
              await unlockPlugin?.unlock?.(cached)
              // success: key unlocked silently, dialog stays closed
            } catch {
              if (accountJid) await clearCachedPassphrase(accountJid)
              openWebUnlockDialog()
            }
          } else {
            openWebUnlockDialog()
          }
        }
```

- [ ] **Step 3: Typecheck**

Run: `npm run build:sdk && cd apps/fluux && npx tsc --noEmit -p .` (or from repo root `npm run typecheck`)
Expected: no errors. (`accountJid` is `const accountJid = jid ? jid.split('/')[0] : null` already declared earlier in the handler; `client` is in scope.)

- [ ] **Step 4: Run the related app tests**

Run: `cd apps/fluux && npx vitest run src/e2ee/webPassphraseCache.test.ts src/components/UnlockEncryptionDialog.test.tsx`
Expected: PASS (still green; this task adds no new test — it is verified end-to-end via Task 1's module tests plus typecheck. App.tsx has no existing unit test harness for this effect).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/App.tsx
git commit -m "feat(e2ee): silently unlock from 24h passphrase cache on connect"
```

---

### Task 5: Clear cache on logout

**Files:**
- Modify: `apps/fluux/src/utils/performLogout.ts`
- Modify: `apps/fluux/src/utils/clearLocalData.ts`

**Interfaces:**
- Consumes: `clearCachedPassphrase`, `clearAllCachedPassphrases` (Task 1).
- Produces: cache cleared on every logout and on full local-data wipe.

- [ ] **Step 1: Add imports to performLogout**

In `apps/fluux/src/utils/performLogout.ts`, add `getBareJid` to the `@fluux/sdk` import. The current first import (line 1) is:

```tsx
import { connectionStore } from '@fluux/sdk'
```

Change it to:

```tsx
import { connectionStore, getBareJid } from '@fluux/sdk'
```

Then add the cache import near the other `@/utils` imports (after line 4):

```tsx
import { clearCachedPassphrase } from '@/e2ee/webPassphraseCache'
```

- [ ] **Step 2: Clear the cache on every logout**

In `performLogout`, immediately after `markLoggedOut()` (line 35), add (keyed by the **bare** JID to match the dialog and connect handler):

```tsx
  // Forget any 24h-cached web passphrase: a deliberate logout should not leave
  // the key unlockable without re-entry. Best-effort; never blocks logout. On
  // desktop there is no record, so this is a harmless no-op.
  if (jid) void clearCachedPassphrase(getBareJid(jid))
```

- [ ] **Step 3: Clear in clearLocalData (CLI full wipe + scoped)**

In `apps/fluux/src/utils/clearLocalData.ts`, add the import after line 18 (`import { clearMediaCache } from '@/utils/mediaCache'`):

```tsx
import { clearCachedPassphrase, clearAllCachedPassphrases } from '@/e2ee/webPassphraseCache'
```

Then, inside `clearLocalData`, in the avatar/media full-wipe section (lines 118-124), extend it so the passphrase cache is cleared too. The current block is:

```tsx
    if (allAccounts) {
      await clearAllAvatarData()
      await clearMediaCache()
    }
```

Replace it with:

```tsx
    if (allAccounts) {
      await clearAllAvatarData()
      await clearMediaCache()
      await clearAllCachedPassphrases()
    } else if (scopedJid) {
      await clearCachedPassphrase(scopedJid)
    }
```

(`scopedJid` is already the bare JID: `const scopedJid = session?.jid ? getBareJid(session.jid) : null` at line 63.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Run the full app test suite for regressions**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no new failures and no stderr noise from the new code.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/performLogout.ts apps/fluux/src/utils/clearLocalData.ts
git commit -m "feat(e2ee): clear 24h passphrase cache on logout and data wipe"
```

---

### Final verification

- [ ] **Run the whole suite + typecheck + lint**

```bash
npm run typecheck
cd apps/fluux && npx vitest run
cd ../.. && npm run lint
```

Expected: all green, no stderr from the new modules.

- [ ] **Manual smoke (web demo or dev server)**

1. `npm run dev`, log into a web account with an existing locked OpenPGP key.
2. On the unlock dialog, verify the checkbox appears (unlock mode), tick it, unlock.
3. Reload the page: confirm the key unlocks silently (no dialog).
4. Log out: log back in and confirm the dialog reappears (cache cleared on logout).
5. Repeat unlock with the box unticked, reload: confirm the dialog reappears.
