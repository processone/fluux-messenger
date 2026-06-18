# Display Cached Media When Auto-Download Is Deferred — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an image is deferred by the media-autoload policy but its bytes are already in the local cache, display it directly from cache (no network request) instead of showing the "Tap to load" placeholder.

**Architecture:** Split each `resolve*` function in `mediaCache.ts` into a network-free `peek*` (cache-read only) plus the existing fetch-and-write. A new read-only hook `useCachedMediaUrl` calls the peek. `ImageAttachment` becomes a three-way branch: consent → existing fetch path; else cache hit → render directly; else → placeholder. `ImageLightbox` gains an `allowFetch` gate so an image shown from cache only never silently fetches a different full-res URL.

**Tech Stack:** React + TypeScript, Vitest + @testing-library/react, Tauri (filesystem cache) / web (Cache API), Zustand (unaffected here).

## Global Constraints

- App test environment is happy-dom by default; tests asserting on rendered DOM here do not need a jsdom pin (no color/gradient/style assertions involved).
- Run app tests per-workspace, not from repo root: `cd apps/fluux && npx vitest run <path>`. Bare `vitest` from root mass-fails on `@/` aliases.
- `peek*` functions MUST be strictly network-free: in-memory index → Tauri `exists()` / web `caches.match()` only. Never call `fetch`/`tauriFetch`.
- Encrypted-media peek needs NO encryption key (the cached plaintext is keyed by `enc:${httpsUrl}` / `.dec` file / `decrypted:${httpsUrl}`).
- Cache is keyed by the **original** (un-sanitized) URL — peeks must pass the original URL, exactly as `resolve*` does.
- Preserve all existing public exports of `mediaCache.ts` and the existing behaviour of `resolveMediaUrl` / `resolveWebMediaUrl` / `resolveEncryptedMediaUrl` / `resolveWebEncryptedMediaUrl`.
- Scope is **images only** (`ImageAttachment` + `ImageLightbox`). Do not touch video/audio/link-preview.

---

### Task 1: Extract network-free `peek*` functions in `mediaCache.ts`

**Files:**
- Modify: `apps/fluux/src/utils/mediaCache.ts`
- Test: `apps/fluux/src/utils/mediaCache.test.ts`

**Interfaces:**
- Consumes: existing module state (`urlCache`, `getCacheFilePath`, `getDecryptedCacheFilePath`).
- Produces (Tauri only — the web counterparts are Task 2):
  - `peekMediaCache(originalUrl: string): Promise<string | null>` (Tauri plaintext)
  - `peekEncryptedMediaCache(httpsUrl: string): Promise<string | null>` (Tauri encrypted)
  - Both return a renderable local URL (`https://asset.localhost/...`) on a hit, `null` on a miss. Neither ever fetches.

- [ ] **Step 1: Write the failing tests**

Append to `apps/fluux/src/utils/mediaCache.test.ts` (the file already mocks tauri/fs/core/http and the web Cache API setup; reuse the existing mock fns `mockIsTauri`, `mockExists`, `mockConvertFileSrc`, `mockTauriFetch`). Add `peekMediaCache` and `peekEncryptedMediaCache` to the existing import from `./mediaCache`.

```typescript
describe('peekMediaCache (Tauri, network-free)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(true)
    mockAppCacheDir.mockResolvedValue('/cache/com.processone.fluux')
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join('/')))
    mockMkdir.mockResolvedValue(undefined)
    mockConvertFileSrc.mockImplementation((p: string) => `https://asset.localhost/${p}`)
  })

  it('returns null on a miss without fetching', async () => {
    mockExists.mockResolvedValue(false)
    const result = await peekMediaCache('https://upload.example.com/a.png')
    expect(result).toBeNull()
    expect(mockTauriFetch).not.toHaveBeenCalled()
  })

  it('returns the asset URL on a filesystem hit without fetching', async () => {
    mockExists.mockResolvedValue(true)
    const result = await peekMediaCache('https://upload.example.com/a.png')
    expect(result).toMatch(/^https:\/\/asset\.localhost\//)
    expect(mockTauriFetch).not.toHaveBeenCalled()
  })
})

describe('peekEncryptedMediaCache (Tauri, network-free)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(true)
    mockAppCacheDir.mockResolvedValue('/cache/com.processone.fluux')
    mockJoin.mockImplementation((...args: string[]) => Promise.resolve(args.join('/')))
    mockMkdir.mockResolvedValue(undefined)
    mockConvertFileSrc.mockImplementation((p: string) => `https://asset.localhost/${p}`)
  })

  it('returns the decrypted asset URL on a hit, with no fetch and no key', async () => {
    mockExists.mockResolvedValue(true)
    const result = await peekEncryptedMediaCache('https://upload.example.com/enc.bin')
    expect(result).toMatch(/^https:\/\/asset\.localhost\/.*\.dec$/)
    expect(mockTauriFetch).not.toHaveBeenCalled()
  })

  it('returns null on a miss', async () => {
    mockExists.mockResolvedValue(false)
    expect(await peekEncryptedMediaCache('https://upload.example.com/enc.bin')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/mediaCache.test.ts -t peek`
Expected: FAIL — `peekMediaCache`/`peekEncryptedMediaCache` is not exported / not a function.

- [ ] **Step 3: Implement the peek functions and re-express the resolvers**

In `apps/fluux/src/utils/mediaCache.ts`, add `peekMediaCache` and refactor `doResolve` to use it. Replace the existing `doResolve` (lines 121-157) body's cache-read section:

```typescript
/**
 * Network-free cache read for plaintext media on Tauri.
 * Checks the in-memory index then the filesystem. Never fetches.
 */
export async function peekMediaCache(originalUrl: string): Promise<string | null> {
  const cached = urlCache.get(originalUrl)
  if (cached) return cached

  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { exists } = await import('@tauri-apps/plugin-fs')

  const filePath = await getCacheFilePath(originalUrl)
  if (await exists(filePath)) {
    const assetUrl = convertFileSrc(filePath)
    urlCache.set(originalUrl, assetUrl)
    return assetUrl
  }
  return null
}

async function doResolve(originalUrl: string): Promise<string> {
  // 1-2. In-memory + filesystem cache (network-free)
  const peeked = await peekMediaCache(originalUrl)
  if (peeked) return peeked

  // 3. Fetch and cache
  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')

  const response = await tauriFetch(originalUrl, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const blob = await response.blob()
  const mimeType = blob.type || response.headers.get('content-type') || undefined

  const finalPath = await getCacheFilePath(originalUrl, mimeType)

  const { writeFile } = await import('@tauri-apps/plugin-fs')
  const arrayBuffer = await new Response(blob).arrayBuffer()
  await writeFile(finalPath, new Uint8Array(arrayBuffer))

  const assetUrl = convertFileSrc(finalPath)
  urlCache.set(originalUrl, assetUrl)
  return assetUrl
}
```

Add `peekEncryptedMediaCache` and refactor `doResolveEncrypted` (lines 210-240). Replace its cache-read section:

```typescript
/**
 * Network-free cache read for encrypted media on Tauri. Returns the cached
 * decrypted (`.dec`) asset URL on a hit. Needs no encryption key.
 */
export async function peekEncryptedMediaCache(httpsUrl: string): Promise<string | null> {
  const cacheKey = `enc:${httpsUrl}`
  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { exists } = await import('@tauri-apps/plugin-fs')

  const filePath = await getDecryptedCacheFilePath(httpsUrl)
  if (await exists(filePath)) {
    const assetUrl = convertFileSrc(filePath)
    urlCache.set(cacheKey, assetUrl)
    return assetUrl
  }
  return null
}

async function doResolveEncrypted(
  httpsUrl: string,
  encryption: FileEncryption,
  cacheKey: string,
): Promise<string> {
  const peeked = await peekEncryptedMediaCache(httpsUrl)
  if (peeked) return peeked

  const { convertFileSrc } = await import('@tauri-apps/api/core')
  const { writeFile } = await import('@tauri-apps/plugin-fs')

  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  const response = await tauriFetch(httpsUrl, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const ciphertext = new Uint8Array(await response.arrayBuffer())
  const plaintext = await decryptFile(ciphertext, encryption.key, encryption.iv)

  const filePath = await getDecryptedCacheFilePath(httpsUrl)
  await writeFile(filePath, new Uint8Array(plaintext))

  const assetUrl = convertFileSrc(filePath)
  urlCache.set(cacheKey, assetUrl)
  return assetUrl
}
```

- [ ] **Step 4: Run the peek tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/mediaCache.test.ts -t peek`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full mediaCache suite to confirm no regression in resolvers**

Run: `cd apps/fluux && npx vitest run src/utils/mediaCache.test.ts`
Expected: PASS (existing resolve/clear/size tests still green).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/mediaCache.ts apps/fluux/src/utils/mediaCache.test.ts
git commit -m "feat(media): add network-free peek*MediaCache reads (Tauri)"
```

---

### Task 2: Add web `peek*` functions in `mediaCache.ts`

**Files:**
- Modify: `apps/fluux/src/utils/mediaCache.ts`
- Test: `apps/fluux/src/utils/mediaCache.test.ts`

**Interfaces:**
- Produces: `peekWebMediaCache`, `peekWebEncryptedMediaCache` (signatures as in Task 1). Both guard `typeof caches === 'undefined'` → return `null` (web without Cache API).

- [ ] **Step 1: Write the failing tests**

Append to `apps/fluux/src/utils/mediaCache.test.ts`. Add `peekWebMediaCache` to the import. This suite stubs a minimal global `caches`.

```typescript
describe('peekWebMediaCache (web Cache API, network-free)', () => {
  let matchResult: Response | undefined
  const fetchSpy = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    resetMediaUrlCache()
    mockIsTauri.mockReturnValue(false)
    matchResult = undefined
    vi.stubGlobal('caches', {
      open: async () => ({ match: async () => matchResult }),
    })
    vi.stubGlobal('fetch', fetchSpy)
  })

  it('returns null on a miss without fetching', async () => {
    matchResult = undefined
    expect(await peekWebMediaCache('https://x/a.png')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns a blob URL on a Cache API hit without fetching', async () => {
    matchResult = new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    const result = await peekWebMediaCache('https://x/a.png')
    expect(result).toMatch(/^blob:/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null when the Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined)
    expect(await peekWebMediaCache('https://x/a.png')).toBeNull()
  })
})
```

> Note: `URL.createObjectURL` exists under happy-dom. If a "createObjectURL is not a function" error appears, add `vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:stub' })` in the suite's `beforeEach`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/mediaCache.test.ts -t peekWebMediaCache`
Expected: FAIL — `peekWebMediaCache` is not a function.

- [ ] **Step 3: Implement the web peek functions and re-express the web resolvers**

In `apps/fluux/src/utils/mediaCache.ts`, add `peekWebMediaCache` and refactor `doResolveWeb` (lines 280-308):

```typescript
/**
 * Network-free cache read for plaintext media on web. Checks the in-memory
 * index then the Cache API. Returns null if no Cache API or no entry.
 */
export async function peekWebMediaCache(originalUrl: string): Promise<string | null> {
  const cached = urlCache.get(originalUrl)
  if (cached) return cached

  if (typeof caches === 'undefined') return null
  const cache = await caches.open(WEB_CACHE_NAME)
  const cachedResponse = await cache.match(originalUrl)
  if (cachedResponse) {
    const blob = await cachedResponse.blob()
    const blobUrl = URL.createObjectURL(blob)
    urlCache.set(originalUrl, blobUrl)
    webBlobUrls.set(originalUrl, blobUrl)
    return blobUrl
  }
  return null
}

async function doResolveWeb(originalUrl: string): Promise<string> {
  const peeked = await peekWebMediaCache(originalUrl)
  if (peeked) return peeked

  const cache = await caches.open(WEB_CACHE_NAME)

  // Fetch and cache
  const response = await fetch(originalUrl)
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const responseClone = response.clone()
  await cache.put(originalUrl, responseClone)

  const blob = await response.blob()
  const blobUrl = URL.createObjectURL(blob)
  urlCache.set(originalUrl, blobUrl)
  webBlobUrls.set(originalUrl, blobUrl)
  return blobUrl
}
```

Add `peekWebEncryptedMediaCache` and refactor `doResolveWebEncrypted` (lines 342-374):

```typescript
/**
 * Network-free cache read for encrypted media on web. Returns a blob URL
 * built from the cached decrypted plaintext. Needs no encryption key.
 */
export async function peekWebEncryptedMediaCache(httpsUrl: string): Promise<string | null> {
  const cacheKey = `enc:${httpsUrl}`
  const cached = urlCache.get(cacheKey)
  if (cached) return cached

  if (typeof caches === 'undefined') return null
  const webCacheKey = `decrypted:${httpsUrl}`
  const cache = await caches.open(WEB_DECRYPTED_CACHE_NAME)
  const cachedResponse = await cache.match(webCacheKey)
  if (cachedResponse) {
    const blob = await cachedResponse.blob()
    const blobUrl = URL.createObjectURL(blob)
    urlCache.set(cacheKey, blobUrl)
    webBlobUrls.set(cacheKey, blobUrl)
    return blobUrl
  }
  return null
}

async function doResolveWebEncrypted(
  httpsUrl: string,
  encryption: FileEncryption,
  cacheKey: string,
): Promise<string> {
  const peeked = await peekWebEncryptedMediaCache(httpsUrl)
  if (peeked) return peeked

  const webCacheKey = `decrypted:${httpsUrl}`
  const cache = await caches.open(WEB_DECRYPTED_CACHE_NAME)

  const response = await fetch(httpsUrl)
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`)
  }

  const ciphertext = new Uint8Array(await response.arrayBuffer())
  const plaintext = await decryptFile(ciphertext, encryption.key, encryption.iv)
  const plaintextBytes = new Uint8Array(plaintext)

  await cache.put(webCacheKey, new Response(new Blob([plaintextBytes])))

  const blobUrl = URL.createObjectURL(new Blob([plaintextBytes]))
  urlCache.set(cacheKey, blobUrl)
  webBlobUrls.set(cacheKey, blobUrl)
  return blobUrl
}
```

- [ ] **Step 4: Run the web peek tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/mediaCache.test.ts -t peekWebMediaCache`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full mediaCache suite**

Run: `cd apps/fluux && npx vitest run src/utils/mediaCache.test.ts`
Expected: PASS (all, including the existing web resolver tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/mediaCache.ts apps/fluux/src/utils/mediaCache.test.ts
git commit -m "feat(media): add network-free peek*MediaCache reads (web)"
```

---

### Task 3: New hook `useCachedMediaUrl`

**Files:**
- Create: `apps/fluux/src/hooks/useCachedMediaUrl.ts`
- Modify: `apps/fluux/src/hooks/index.ts:26` (add export)
- Test: `apps/fluux/src/hooks/useCachedMediaUrl.test.ts`

**Interfaces:**
- Consumes: `peekMediaCache`, `peekWebMediaCache`, `peekEncryptedMediaCache`, `peekWebEncryptedMediaCache` from `@/utils/mediaCache`; `isTauri` from `@/utils/tauri`.
- Produces: `useCachedMediaUrl(url: string | undefined, encryption: FileEncryption | undefined, enabled?: boolean): { cachedUrl: string | null; isPeeking: boolean }`. Read-only — never triggers a network fetch. Returns `{ cachedUrl: null, isPeeking: false }` when `!url || !enabled`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/useCachedMediaUrl.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const { peekMediaCacheSpy, peekWebMediaCacheSpy, peekEncryptedSpy, peekWebEncryptedSpy } = vi.hoisted(() => ({
  peekMediaCacheSpy: vi.fn(),
  peekWebMediaCacheSpy: vi.fn(),
  peekEncryptedSpy: vi.fn(),
  peekWebEncryptedSpy: vi.fn(),
}))
const mockIsTauri = vi.fn()

vi.mock('@/utils/tauri', () => ({ isTauri: () => mockIsTauri() }))
vi.mock('@/utils/mediaCache', () => ({
  peekMediaCache: (u: string) => peekMediaCacheSpy(u),
  peekWebMediaCache: (u: string) => peekWebMediaCacheSpy(u),
  peekEncryptedMediaCache: (u: string) => peekEncryptedSpy(u),
  peekWebEncryptedMediaCache: (u: string) => peekWebEncryptedSpy(u),
}))

import { useCachedMediaUrl } from './useCachedMediaUrl'

describe('useCachedMediaUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
    peekWebMediaCacheSpy.mockResolvedValue(null)
    peekMediaCacheSpy.mockResolvedValue(null)
    peekEncryptedSpy.mockResolvedValue(null)
    peekWebEncryptedSpy.mockResolvedValue(null)
  })

  it('returns the cached URL on a web plaintext hit', async () => {
    peekWebMediaCacheSpy.mockResolvedValue('blob:hit')
    const { result } = renderHook(() => useCachedMediaUrl('https://x/a.png', undefined, true))
    await waitFor(() => expect(result.current.isPeeking).toBe(false))
    expect(result.current.cachedUrl).toBe('blob:hit')
    expect(peekWebMediaCacheSpy).toHaveBeenCalledWith('https://x/a.png')
  })

  it('returns null on a miss', async () => {
    const { result } = renderHook(() => useCachedMediaUrl('https://x/a.png', undefined, true))
    await waitFor(() => expect(result.current.isPeeking).toBe(false))
    expect(result.current.cachedUrl).toBeNull()
  })

  it('does nothing when disabled', async () => {
    const { result } = renderHook(() => useCachedMediaUrl('https://x/a.png', undefined, false))
    expect(result.current).toEqual({ cachedUrl: null, isPeeking: false })
    expect(peekWebMediaCacheSpy).not.toHaveBeenCalled()
  })

  it('uses the encrypted peek when encryption is present', async () => {
    peekWebEncryptedSpy.mockResolvedValue('blob:dec')
    const enc = { key: new Uint8Array(), iv: new Uint8Array() } as never
    const { result } = renderHook(() => useCachedMediaUrl('https://x/enc.bin', enc, true))
    await waitFor(() => expect(result.current.isPeeking).toBe(false))
    expect(result.current.cachedUrl).toBe('blob:dec')
    expect(peekWebEncryptedSpy).toHaveBeenCalledWith('https://x/enc.bin')
    expect(peekWebMediaCacheSpy).not.toHaveBeenCalled()
  })

  it('uses the Tauri peek when isTauri()', async () => {
    mockIsTauri.mockReturnValue(true)
    peekMediaCacheSpy.mockResolvedValue('https://asset.localhost/x')
    const { result } = renderHook(() => useCachedMediaUrl('https://x/a.png', undefined, true))
    await waitFor(() => expect(result.current.isPeeking).toBe(false))
    expect(result.current.cachedUrl).toBe('https://asset.localhost/x')
    expect(peekMediaCacheSpy).toHaveBeenCalledWith('https://x/a.png')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useCachedMediaUrl.test.ts`
Expected: FAIL — cannot find module `./useCachedMediaUrl`.

- [ ] **Step 3: Implement the hook**

Create `apps/fluux/src/hooks/useCachedMediaUrl.ts`:

```typescript
import { useState, useEffect } from 'react'
import { type FileEncryption } from '@fluux/sdk'
import { isTauri } from '@/utils/tauri'
import {
  peekMediaCache,
  peekWebMediaCache,
  peekEncryptedMediaCache,
  peekWebEncryptedMediaCache,
} from '@/utils/mediaCache'

interface CachedUrlState {
  /** Local URL (asset/blob) if the bytes are already cached, else null. */
  cachedUrl: string | null
  /** True while the network-free cache peek is in flight. */
  isPeeking: boolean
}

/**
 * Read-only sibling of useAttachmentUrl: returns the already-cached local URL
 * for a (possibly encrypted) attachment WITHOUT ever fetching from the network.
 *
 * Used to display media that the autoload policy would defer but whose bytes
 * are already present locally — a cache hit leaks nothing, so the deferral has
 * no privacy purpose for it.
 */
export function useCachedMediaUrl(
  url: string | undefined,
  encryption: FileEncryption | undefined,
  enabled: boolean = true,
): CachedUrlState {
  const [state, setState] = useState<CachedUrlState>(() => ({
    cachedUrl: null,
    isPeeking: Boolean(url && enabled),
  }))

  useEffect(() => {
    if (!url || !enabled) {
      setState({ cachedUrl: null, isPeeking: false })
      return
    }
    let cancelled = false
    setState({ cachedUrl: null, isPeeking: true })

    const isEncrypted = Boolean(encryption)
    const peek = isTauri()
      ? (isEncrypted ? peekEncryptedMediaCache : peekMediaCache)
      : (isEncrypted ? peekWebEncryptedMediaCache : peekWebMediaCache)

    peek(url).then(
      result => { if (!cancelled) setState({ cachedUrl: result, isPeeking: false }) },
      () => { if (!cancelled) setState({ cachedUrl: null, isPeeking: false }) },
    )

    return () => { cancelled = true }
  }, [url, encryption, enabled])

  return state
}
```

- [ ] **Step 4: Add the export**

In `apps/fluux/src/hooks/index.ts`, after line 26 add:

```typescript
export { useCachedMediaUrl } from './useCachedMediaUrl'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useCachedMediaUrl.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useCachedMediaUrl.ts apps/fluux/src/hooks/useCachedMediaUrl.test.ts apps/fluux/src/hooks/index.ts
git commit -m "feat(media): add useCachedMediaUrl read-only peek hook"
```

---

### Task 4: Display cached media in `ImageAttachment` (three-way branch)

**Files:**
- Modify: `apps/fluux/src/components/FileAttachments.tsx:36-208` (`ImageAttachment`)
- Test: `apps/fluux/src/components/FileAttachments.test.tsx`

**Interfaces:**
- Consumes: `useDeferredMedia` (`{ shouldLoad, approve }`), `useAttachmentUrl` (`{ url, isLoading, error }`), `useCachedMediaUrl` (`{ cachedUrl, isPeeking }`).
- Produces: render behaviour — when `!shouldLoad` and a cache hit exists, renders `<img>` from the cached URL (no fetch); passes `allowFetch={shouldLoad}` to `ImageLightbox` (consumed in Task 5).

- [ ] **Step 1: Write the failing tests**

The existing test file mocks `@/hooks` (see its top). First update that mock so `useCachedMediaUrl` exists; add a hoisted spy and a default return. In `apps/fluux/src/components/FileAttachments.test.tsx`:

Change the `vi.hoisted` block (currently `const { useAttachmentUrlSpy } = vi.hoisted(...)`) to:

```typescript
const { useAttachmentUrlSpy, useCachedMediaUrlSpy } = vi.hoisted(() => ({
  useAttachmentUrlSpy: vi.fn(),
  useCachedMediaUrlSpy: vi.fn(),
}))
```

Add `useCachedMediaUrl` to the `vi.mock('@/hooks', ...)` factory return object:

```typescript
  useCachedMediaUrl: (url: string | undefined, enc: unknown, enabled: boolean) =>
    useCachedMediaUrlSpy(url, enc, enabled),
```

In the top-level `beforeEach`, default the new spy to a miss:

```typescript
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
```

Also add `useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })` to the `ImageAttachment deferral` suite's `beforeEach` (so its existing "defers" test still sees a miss).

Now add a new suite:

```typescript
describe('ImageAttachment cached-while-deferred', () => {
  const attachment = { url: 'https://x/a.jpg', name: 'a.jpg', mediaType: 'image/jpeg', size: 1234, width: 800, height: 600 }

  beforeEach(() => {
    vi.clearAllMocks()
    __resetApprovedMediaUrlsForTest()
    // Deferred: the consent-gated fetch path returns nothing.
    useAttachmentUrlSpy.mockImplementation((_u: string | undefined, _e: unknown, enabled: boolean) => ({
      url: enabled ? 'blob:fetched' : null,
      isLoading: false,
      error: null,
    }))
  })

  it('renders the image from cache without entering the fetch path', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: 'blob:cached', isPeeking: false })
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={attachment} />
      </MediaAutoloadProvider>,
    )
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'blob:cached')
    expect(screen.queryByText('chat.loadImage')).not.toBeInTheDocument()
    // Fetch path must be disabled while displaying from cache.
    expect(useAttachmentUrlSpy).toHaveBeenLastCalledWith('https://x/a.jpg', undefined, false)
  })

  it('shows the placeholder on a cache miss', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={attachment} />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('chat.loadImage')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows neither image nor placeholder while peeking', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: true })
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={attachment} />
      </MediaAutoloadProvider>,
    )
    expect(screen.queryByText('chat.loadImage')).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('peek is disabled (not called with enabled) once the user consents', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
    render(<ImageAttachment attachment={attachment} />) // no provider → autoLoad true
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:fetched')
    // Peek must be disabled when the fetch path is active.
    expect(useCachedMediaUrlSpy).toHaveBeenLastCalledWith('https://x/a.jpg', undefined, false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx -t cached-while-deferred`
Expected: FAIL — component does not yet call `useCachedMediaUrl` / still shows placeholder on a hit.

- [ ] **Step 3: Implement the three-way branch**

In `apps/fluux/src/components/FileAttachments.tsx`:

Update the import on line 7 to include `useCachedMediaUrl`:

```typescript
import { formatBytes, useAttachmentUrl, useCachedMediaUrl } from '@/hooks'
```

After the `useAttachmentUrl` call (lines 61-65), add the peek and derive the effective source. Insert:

```typescript
  // When deferred, peek the local cache (network-free). A hit means the bytes
  // were already fetched once under consent, so displaying them leaks nothing.
  const { cachedUrl, isPeeking } = useCachedMediaUrl(
    originalImageSrc,
    originalEncryption,
    isImage && !shouldLoad,
  )

  // Source actually rendered: the consent-gated fetch result, or the cache hit.
  const effectiveSrc = shouldLoad ? proxiedImageSrc : cachedUrl
  // True when shown purely from cache without consent — gates lightbox fetch.
  const displayedFromCacheOnly = !shouldLoad && Boolean(cachedUrl)
```

Replace the deferral early-return block (lines 93-107) so it only fires on a true miss (deferred, not cached, not peeking):

```typescript
  // Show tap-to-load placeholder only when deferred AND nothing is cached.
  if (isImage && !shouldLoad && !cachedUrl && !isPeeking) {
    return (
      <DeferredMediaPlaceholder
        variant="box"
        icon={ImageIcon}
        label={t('chat.loadImage')}
        name={attachment.name}
        sizeLabel={attachment.size ? formatBytes(attachment.size) : undefined}
        aspectRatio={aspectRatio}
        maxWidthPx={maxWidthPx}
        onLoad={approve}
      />
    )
  }
```

Update the loading guard (lines 110-119) to also cover the in-flight peek:

```typescript
  // Show loading placeholder while fetching (consent path) or peeking the cache.
  if ((shouldLoad && isLoading) || (!shouldLoad && isPeeking)) {
    return (
      <div
        className="pt-2 rounded-lg bg-fluux-hover/60 flex items-center justify-center"
        style={{ aspectRatio, maxWidth: `${maxWidthPx}px`, maxHeight: '300px', minHeight: '100px' }}
      >
        <Loader2 className="size-6 text-fluux-muted animate-spin" />
      </div>
    )
  }
```

Replace `proxiedImageSrc` with `effectiveSrc` in the error guard (line 127) and the `<img>` / context-menu / lightbox render (lines 155-205). Specifically:

- Line 127: `if (error || !effectiveSrc || loadError) {`
- Line 172: `src={effectiveSrc}`
- Line 191: `proxiedUrl={effectiveSrc}`
- Lightbox block (lines 195-205): use `effectiveSrc` for `placeholderSrc` and pass the new `allowFetch` prop:

```typescript
      {lightboxOpen && (
        <ImageLightbox
          src={attachment.url}
          placeholderSrc={effectiveSrc ?? undefined}
          alt={attachment.name || 'Image attachment'}
          downloadUrl={attachment.url}
          encryption={attachment.encryption}
          filename={attachment.name}
          allowFetch={!displayedFromCacheOnly}
          onClose={() => setLightboxOpen(false)}
        />
      )}
```

> `allowFetch` does not exist on `ImageLightbox` yet — Task 5 adds it. TypeScript will flag it until then; that is expected within this task's red/green cycle (the component test mocks `ImageLightbox` to `() => null`, so the runtime tests pass; typecheck is run at the end of Task 5).

- [ ] **Step 4: Run the component tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx`
Expected: PASS — new `cached-while-deferred` suite green; existing `deferral` and legacy suites still green.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/FileAttachments.tsx apps/fluux/src/components/FileAttachments.test.tsx
git commit -m "feat(media): display already-cached images even when autoload defers"
```

---

### Task 5: Gate full-res fetch in `ImageLightbox` with `allowFetch`

**Files:**
- Modify: `apps/fluux/src/components/ImageLightbox.tsx`
- Test: `apps/fluux/src/components/ImageLightbox.test.tsx` (create)

**Interfaces:**
- Consumes: `useAttachmentUrl` (gated by `allowFetch`), `useCachedMediaUrl` (always peeks full-res).
- Produces: new optional prop `allowFetch?: boolean` (default `true`, preserving every existing call site). When `false`, the full-res image is never fetched: it shows the peeked full-res cache if present, else the `placeholderSrc` thumbnail.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/ImageLightbox.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ImageLightbox } from './ImageLightbox'

const { useAttachmentUrlSpy, useCachedMediaUrlSpy } = vi.hoisted(() => ({
  useAttachmentUrlSpy: vi.fn(),
  useCachedMediaUrlSpy: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks', () => ({
  useAttachmentUrl: (u: string | undefined, e: unknown, enabled?: boolean) => useAttachmentUrlSpy(u, e, enabled),
}))
vi.mock('@/hooks/useCachedMediaUrl', () => ({
  useCachedMediaUrl: (u: string | undefined, e: unknown, enabled?: boolean) => useCachedMediaUrlSpy(u, e, enabled),
}))
vi.mock('./ImageContextMenu', () => ({ ImageContextMenu: () => null }))
vi.mock('@/hooks/useContextMenu', () => ({ useContextMenu: () => ({ handleContextMenu: vi.fn() }) }))

describe('ImageLightbox allowFetch gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAttachmentUrlSpy.mockReturnValue({ url: null, isLoading: false, error: null })
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  it('fetches the full-res image by default (allowFetch defaults true)', () => {
    useAttachmentUrlSpy.mockReturnValue({ url: 'blob:fullres', isLoading: false, error: null })
    render(<ImageLightbox src="https://x/full.jpg" downloadUrl="https://x/full.jpg" onClose={() => {}} />)
    expect(useAttachmentUrlSpy).toHaveBeenCalledWith('https://x/full.jpg', undefined, true)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:fullres')
  })

  it('does NOT fetch full-res when allowFetch is false, showing the thumbnail instead', () => {
    render(
      <ImageLightbox
        src="https://x/full.jpg"
        downloadUrl="https://x/full.jpg"
        placeholderSrc="blob:thumb"
        allowFetch={false}
        onClose={() => {}}
      />,
    )
    expect(useAttachmentUrlSpy).toHaveBeenCalledWith('https://x/full.jpg', undefined, false)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:thumb')
  })

  it('upgrades to the cached full-res when present, still without fetching', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: 'blob:fullres-cached', isPeeking: false })
    render(
      <ImageLightbox
        src="https://x/full.jpg"
        downloadUrl="https://x/full.jpg"
        placeholderSrc="blob:thumb"
        allowFetch={false}
        onClose={() => {}}
      />,
    )
    expect(useAttachmentUrlSpy).toHaveBeenCalledWith('https://x/full.jpg', undefined, false)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:fullres-cached')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/ImageLightbox.test.tsx`
Expected: FAIL — `allowFetch` not honored; `useCachedMediaUrl` not called by the component.

- [ ] **Step 3: Implement the gate**

In `apps/fluux/src/components/ImageLightbox.tsx`:

Add the import (after line 10):

```typescript
import { useCachedMediaUrl } from '@/hooks/useCachedMediaUrl'
```

Add the prop to the interface (after `placeholderSrc`, line 27):

```typescript
  /** When false, never fetch the full-res image — show cached full-res or the placeholder only. */
  allowFetch?: boolean
```

Update the destructure and resolution (lines 32-45):

```typescript
export function ImageLightbox({ src, alt, downloadUrl, filename, encryption, placeholderSrc, allowFetch = true, onClose }: ImageLightboxProps) {
  const { t } = useTranslation()
  const { url: proxiedSrc, isLoading } = useAttachmentUrl(src, encryption, allowFetch)
  const { cachedUrl: cachedFullRes } = useCachedMediaUrl(src, encryption, !allowFetch)
  const imageMenu = useContextMenu()

  // ... keep the existing Escape effect ...

  const displaySrc = proxiedSrc ?? cachedFullRes ?? placeholderSrc
```

(`useAttachmentUrl`'s third arg already exists and defaults to `true`, so existing callers passing no `allowFetch` get `allowFetch=true` → unchanged behaviour. The download button and context menu keep using `proxiedSrc ?? downloadUrl`.)

- [ ] **Step 4: Run the lightbox tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/ImageLightbox.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck the whole app (resolves the Task 4 forward-reference)**

Run: `npm run typecheck`
Expected: PASS — `allowFetch` now exists on `ImageLightbox`, so the `FileAttachments.tsx` usage typechecks.

> If typecheck fails resolving `@fluux/sdk` types in this worktree, build the SDK first (`npm run build:sdk`) and ensure the worktree's `node_modules/@fluux/sdk` is in place, per the project's worktree notes, then re-run.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/ImageLightbox.tsx apps/fluux/src/components/ImageLightbox.test.tsx
git commit -m "feat(media): gate lightbox full-res fetch when shown from cache only"
```

---

### Task 6: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the affected test files together**

Run:
```bash
cd apps/fluux && npx vitest run \
  src/utils/mediaCache.test.ts \
  src/hooks/useCachedMediaUrl.test.ts \
  src/components/FileAttachments.test.tsx \
  src/components/ImageLightbox.test.tsx
```
Expected: PASS, no stderr.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both PASS, no errors.

- [ ] **Step 3: Confirm no regression in the broader app suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS (or unchanged from the pre-change baseline).

- [ ] **Step 4: Final commit (only if any lint autofixes were applied)**

```bash
git add -A
git commit -m "chore(media): lint/typecheck cleanup for cached-media display"
```

---

## Self-Review

**Spec coverage:**
- "Split cache-read from fetch in `mediaCache.ts`" → Tasks 1 (Tauri) + 2 (web).
- "New hook `useCachedMediaUrl`" → Task 3.
- "Three-way branch in `ImageAttachment`" → Task 4.
- "Lightbox must not fetch a different full-res URL when shown from cache" → Task 5 (`allowFetch`).
- "Web without Cache API → peek miss → placeholder stays" → covered by `peekWeb*` `typeof caches === 'undefined'` guard (Task 2) and the hook test for the disabled/miss path (Task 3); the `useProxiedUrl` direct-passthrough path is unchanged.
- "Peek-in-progress shows reserved box, no flicker" → Task 4 loading-guard update + `isPeeking` test.
- "All deferred contexts, no stranger special-case" → no trust-specific code added; `useCachedMediaUrl` is enabled purely by `!shouldLoad`, which already covers strangers/public/never.
- "Scope images only" → only `ImageAttachment` + `ImageLightbox` touched; video/audio/link-preview untouched.
- Tests: cache-hit renders without fetch (Task 4 asserts `useAttachmentUrl` called with `enabled=false`); cache-miss defers; encrypted hit (Task 3); lightbox-from-cache no full-res fetch (Task 5); web-without-Cache-API (Tasks 2/3).

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows full code.

**Type consistency:** `peekMediaCache`/`peekWebMediaCache`/`peekEncryptedMediaCache`/`peekWebEncryptedMediaCache` all `(string) => Promise<string | null>`, used identically in Task 3. `useCachedMediaUrl(url, encryption, enabled)` returns `{ cachedUrl, isPeeking }` — same shape consumed in Tasks 4 and 5. `allowFetch?: boolean` defined in Task 5, passed in Task 4. `effectiveSrc`/`displayedFromCacheOnly` defined and used within Task 4 only.
