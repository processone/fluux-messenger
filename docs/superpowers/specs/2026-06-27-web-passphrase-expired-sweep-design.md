# Web passphrase cache — proactive expired-record sweep

**Date:** 2026-06-27
**Status:** Approved (design)
**Builds on:** [`2026-06-27-web-passphrase-24h-cache-design.md`](2026-06-27-web-passphrase-24h-cache-design.md)

## Problem

The web-only OpenPGP passphrase cache (`apps/fluux/src/e2ee/webPassphraseCache.ts`)
stores the encrypted passphrase in IndexedDB with a fixed 24h `expiresAt`. Today an
expired record is only removed **lazily**: `loadCachedPassphrase(jid)` checks
`Date.now() > expiresAt` and deletes — but only for the one JID being loaded, and only
when that load path actually runs (on connect).

This leaves outdated material at rest in two cases:

1. **Reopen-after-24h** — the user returns but the connect/unlock path never calls
   `loadCachedPassphrase` for that exact JID, so the expired ciphertext + its
   non-extractable `CryptoKey` linger in IndexedDB indefinitely.
2. **Cross-account leftovers** — account A's record is never cleared when the user later
   signs in as account B.

### Why it matters

The 24h expiry is the mechanism that bounds exposure. The non-extractable AES-GCM key
blocks a passive storage dump, but a live-JS (XSS) attacker arriving **after** the 24h
window could still call `subtle.decrypt` against the lingering key. Eagerly deleting the
record once it is stale is what actually closes that window.

## Goal

Delete outdated cached passphrases as soon as the app can — not only on next access for
the matching JID.

## Design

Additive, web-only, best-effort. No behavior change to the happy path.

### 1. `sweepExpiredPassphrases()` in `webPassphraseCache.ts`

```ts
export async function sweepExpiredPassphrases(): Promise<void>
```

Opens the cache DB and walks **all** records with a single readwrite cursor, calling
`cursor.delete()` on any record where `Date.now() > expiresAt`. This clears both the
reopen-after-24h ciphertext and stale cross-account leftovers in one pass.

Best-effort, consistent with every other op in the module: wrap in `try/catch`, log a
`console.warn` on failure, never throw, never block.

### 2. Call once at boot in `main.tsx`

Inside the existing `if (!isTauri) { … }` boot block (web-only, runs before React mounts,
does not wait for a connect):

```ts
void sweepExpiredPassphrases()
```

Fire-and-forget so it cannot delay startup. Tauri is unaffected (it uses the OS keychain,
not this cache).

### 3. Keep existing lazy deletion

The `Date.now() > record.expiresAt` check and `deleteRecord` in `loadCachedPassphrase`
stay as-is. The startup sweep is additive defense-in-depth, not a replacement.

## Out of scope

No live timer / `setInterval` for a tab left continuously open past 24h. That case still
purges on the tab's next reload or connect. (Explicit choice: startup sweep only.)

## Testing

Add to the existing `apps/fluux/src/e2ee/webPassphraseCache.test.ts` (already uses
`fake-indexeddb`):

- Seed one expired record (`expiresAt` in the past) and one fresh record → run
  `sweepExpiredPassphrases()` → assert the expired record is gone and the fresh one
  survives (e.g. `loadCachedPassphrase` still returns the fresh passphrase, returns null
  for the expired JID).
- `sweepExpiredPassphrases()` on an empty DB is a safe no-op and does not throw.
