# Display already-cached media even when auto-download is deferred

**Date:** 2026-06-18
**Status:** Design approved, pending spec review

## Problem

Media auto-download deferral (`computeMediaAutoload`) protects privacy by not
fetching remote media in low-trust contexts (public rooms, strangers,
`never` policy). When it returns `false`, the attachment renders a
`DeferredMediaPlaceholder` ("Tap to load") and **never resolves a URL** — even
when the exact bytes are already sitting in the local media cache.

This is unnecessarily restrictive. Deferral exists to prevent a network request
to the media host (which would leak the user's IP, presence, and read time). A
**cache hit involves no network request**, so displaying it leaks nothing.

Furthermore, media only ever enters the cache through a consent-gated render
path: the cache is written exclusively by `resolve*` functions in
`mediaCache.ts`, called only when `enabled === shouldLoad === (autoLoad || approved)`.
There is no background prefetch, MAM sync, or link-preview path that silently
caches message media. So **presence in the cache implies the bytes were already
fetched once under an allowed policy or explicit user approval** — the user has
already seen these bytes, and re-displaying them creates neither a new leak nor a
new consent question.

**Goal:** When media is deferred but already present in the local cache, display
it directly from cache instead of showing the placeholder.

## Scope

- **In scope:** Images — `ImageAttachment` in `FileAttachments.tsx` and the
  full-resolution `ImageLightbox`.
- **All deferred contexts** benefit (public rooms, `never`-policy private
  contacts, and 1:1 strangers). No stranger special-case: a cache hit means the
  bytes were already fetched once under consent, so the stranger hard-floor has
  nothing left to protect.
- **Out of scope (trivial follow-up):** video poster, audio, and link-preview
  images use the identical deferral gate and can adopt the same peek later.
  Not built now (YAGNI).

## Non-goals

- Changing the auto-download policy model or trust matrix.
- Pre-caching / prefetching media to make more hits available.
- Any new network behaviour. The peek is strictly read-only.

## Approach: split cache-read from fetch, peek = the read half

The core change is a structural one in `mediaCache.ts`: separate the
**cache-read** step from the **fetch-and-write** step, so a "peek" is the
read step alone and can never trigger a network request.

### `mediaCache.ts` refactor

Each of the four resolver functions currently does "check cache, else fetch and
write". Extract the read step into a network-free peek:

| New peek (read-only)             | Existing resolver becomes        |
|----------------------------------|----------------------------------|
| `peekMediaCache(url)`            | `peekMediaCache ?? fetchAndWrite`|
| `peekWebMediaCache(url)`         | `peekWebMediaCache ?? fetchAndWrite` |
| `peekEncryptedMediaCache(url)`   | `peekEncryptedMediaCache ?? fetchAndWriteDecrypted` |
| `peekWebEncryptedMediaCache(url)`| `peekWebEncryptedMediaCache ?? fetchAndWriteDecrypted` |

Each `peek*` returns a ready-to-render local URL (`asset://localhost/...` on
Tauri, `blob:...` on web) on a hit, or `null` on a miss. It reads:

1. the in-memory `urlCache` index (sync fast path), then
2. the Tauri filesystem (`exists()`) **or** the web Cache API (`caches.match`,
   which does not hit the network); for encrypted media, the decrypted-plaintext
   store (`.dec` file / `fluux-media-decrypted` cache).

On a web Cache-API hit, the peek creates a blob URL via `createObjectURL` and
records it in `urlCache` / `webBlobUrls` exactly as `resolve*` does, so blob
lifecycle and dedup are unchanged and there is no divergence between the two
paths.

The existing `resolve*` functions are re-expressed as `peek* ?? fetchAndWrite()`,
so their external behaviour is unchanged and all current callers keep working.

### New hook: `useCachedMediaUrl(url, encryption)`

A read-only sibling to `useAttachmentUrl`. It dispatches on `encryption`
presence (encrypted → `peekEncrypted*`, plaintext → `peek*`) and on platform
(Tauri vs web vs web-without-Cache-API), mirroring `useAttachmentUrl`'s dispatch
but calling only the peek functions. Returns:

```ts
{ cachedUrl: string | null; isPeeking: boolean }
```

- `isPeeking` is `true` while the async peek is in flight.
- `cachedUrl` is the renderable local URL on a hit, else `null`.

On web-without-Cache-API there is no persistent cache, so the hook resolves
immediately to `{ cachedUrl: null, isPeeking: false }` — placeholder stays,
no regression.

### Component wiring (`ImageAttachment`)

The render decision becomes a three-way branch on the existing
`shouldLoad` from `useDeferredMedia` plus the new peek:

```
if (shouldLoad)            → existing useAttachmentUrl path (unchanged: may fetch)
else if (cachedUrl)        → render <img src={cachedUrl}>  (from cache, no fetch)
else if (isPeeking)        → render placeholder's reserved box (no flicker)
else                       → render DeferredMediaPlaceholder ("Tap to load")
```

The placeholder's `approve()` consent flow is untouched: tapping it sets
`shouldLoad` and the normal fetch proceeds as today.

A flag (e.g. `displayedFromCacheOnly = !shouldLoad && !!cachedUrl`) records that
the image is shown from cache without consent, to drive the lightbox edge case
below.

## Edge cases

### Lightbox / full-resolution fetch

`ImageLightbox` currently calls `useAttachmentUrl(src, encryption)` with no
`enabled` arg (defaults to `true`) — safe today only because the lightbox opens
after a consented thumbnail render. With this change an image can be shown from
cache **without** consent, and the full-res URL may differ from the (cached)
thumbnail URL. Clicking it must not silently fetch the full-res.

**Resolution:** when the image is `displayedFromCacheOnly`, the lightbox must not
enter the fetch path for the full-res image. It instead:

- peeks the full-res cache (`useCachedMediaUrl(src, encryption)`); if cached,
  display it; otherwise
- treat the click as a consent action — route through the same `approve()` gate
  so the user explicitly opts into fetching the full-res bytes.

Concretely, `ImageLightbox` takes an `enabled`/`allowFetch` prop derived from the
parent's consent state instead of defaulting to unconditional fetch.

### Same URL across conversations

The cache is keyed globally by URL, so a hit in a stranger chat may display bytes
first fetched in a contact chat. This is acceptable and intended: the user has
already seen those bytes, and no new network request occurs.

### Peek-in-progress flicker

The peek is async. To avoid a placeholder→image flash, render the placeholder's
reserved (aspect-ratio) box while `isPeeking`, then resolve to image or the full
placeholder. No layout shift.

## Testing

- **Cache hit displays without fetch:** with a deferred context and a primed
  cache peek, the image renders from `cachedUrl` and the `resolve*` / underlying
  `fetch` is never called (assert the fetch/resolver mock has zero calls).
- **Cache miss defers:** deferred + empty cache → `DeferredMediaPlaceholder`
  renders.
- **Encrypted hit:** a primed decrypted-plaintext cache renders the decrypted
  local URL with no fetch and no key access.
- **Consent path unchanged:** `shouldLoad === true` still goes through
  `useAttachmentUrl` (regression guard).
- **Lightbox from cache:** an image shown from cache only, whose full-res URL is
  not cached, does not fetch full-res on click — it routes through consent.
- **Web without Cache API:** peek resolves to `null`; placeholder stays.

## Files touched

- `apps/fluux/src/utils/mediaCache.ts` — extract `peek*` from `resolve*`.
- `apps/fluux/src/hooks/useCachedMediaUrl.ts` — **new** read-only peek hook.
- `apps/fluux/src/components/FileAttachments.tsx` — three-way branch in
  `ImageAttachment`; pass consent state to the lightbox.
- `apps/fluux/src/components/ImageLightbox.tsx` — gate full-res fetch on consent;
  peek full-res cache.
- Test files for `mediaCache`, the new hook, and `ImageAttachment`/lightbox.
