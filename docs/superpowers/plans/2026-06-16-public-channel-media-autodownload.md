# Public-Channel Media Auto-Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the app from automatically fetching message media (images, video, audio, text-file previews, link-preview images) in public rooms and in 1:1 chats from strangers; let the user pick a policy (Always / Private only / Never, default Private only), with strangers as a hard floor that never auto-loads.

**Architecture:** A pure `computeMediaAutoload(policy, trust)` helper + a React context (`useMediaAutoload`, defaults to `true` when unprovided) wrap each conversation's message list. `RoomView` derives trust from `activeRoom.isPrivate`; `ChatView` from whether the peer is in the roster (`contactsByJid.has`). Each media renderer gates its existing fetch hook on `autoLoad || tappedThisSession` and otherwise shows a tappable `DeferredMediaPlaceholder`. A new "Privacy" settings category exposes the policy. Feature is entirely in `apps/fluux` (no SDK change).

**Tech Stack:** React + TypeScript, Zustand (`settingsStore`), Vitest + @testing-library/react, i18next (33 locales), Tailwind, lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-16-public-channel-media-autodownload-design.md`

---

## File structure

New files:
- `apps/fluux/src/utils/mediaAutoload.ts` — pure policy helper + session-approved-URL set.
- `apps/fluux/src/utils/mediaAutoload.test.ts` — unit tests for the above.
- `apps/fluux/src/contexts/MediaAutoloadContext.tsx` — provider + `useMediaAutoload`.
- `apps/fluux/src/contexts/MediaAutoloadContext.test.tsx` — default + override tests.
- `apps/fluux/src/components/DeferredMediaPlaceholder.tsx` — presentational tap-to-load placeholder.
- `apps/fluux/src/components/DeferredMediaPlaceholder.test.tsx` — render + onLoad test.
- `apps/fluux/src/components/settings-components/PrivacySettings.tsx` — Privacy settings panel.

Modified files:
- `apps/fluux/src/stores/settingsStore.ts` (+ `settingsStore.test.ts`) — `mediaAutoDownload` preference.
- `apps/fluux/src/components/FileAttachments.tsx` (+ `FileAttachments.test.tsx` new) — gate image/video/audio.
- `apps/fluux/src/components/TextFilePreview.tsx` — gate text preview.
- `apps/fluux/src/components/LinkPreviewCard.tsx` (+ existing `LinkPreviewCard.test.tsx`) — gate OG image.
- `apps/fluux/src/components/ChatView.tsx` — provide context (stranger trust).
- `apps/fluux/src/components/RoomView.tsx` — provide context (room trust).
- `apps/fluux/src/components/settings-components/types.ts` — add `privacy` category.
- `apps/fluux/src/components/settings-components/index.ts` — export `PrivacySettings`.
- `apps/fluux/src/components/SettingsView.tsx` — route `privacy`.
- `apps/fluux/src/i18n/locales/*.json` — new keys in all 33 locales.

---

## Task 1: `mediaAutoDownload` preference in settingsStore

**Files:**
- Modify: `apps/fluux/src/stores/settingsStore.ts`
- Test: `apps/fluux/src/stores/settingsStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe('settingsStore', () => { ... })` in `settingsStore.test.ts` (after the existing `setThemeMode` block):

```ts
  describe('mediaAutoDownload', () => {
    it('defaults to private-only when localStorage is empty', () => {
      useSettingsStore.setState({ mediaAutoDownload: 'private-only' })
      expect(useSettingsStore.getState().mediaAutoDownload).toBe('private-only')
    })

    it('setMediaAutoDownload persists to localStorage', () => {
      useSettingsStore.getState().setMediaAutoDownload('always')
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-media-autodownload', 'always')
      expect(useSettingsStore.getState().mediaAutoDownload).toBe('always')
    })

    it('accepts all three policy values', () => {
      const { setMediaAutoDownload } = useSettingsStore.getState()
      for (const v of ['always', 'private-only', 'never'] as const) {
        setMediaAutoDownload(v)
        expect(useSettingsStore.getState().mediaAutoDownload).toBe(v)
      }
    })
  })
```

Also extend the existing `beforeEach` reset call to include the new field:

```ts
    useSettingsStore.setState({ themeMode: 'system', timeFormat: 'auto', fontSize: 100, mediaAutoDownload: 'private-only' })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/stores/settingsStore.test.ts`
Expected: FAIL — `setMediaAutoDownload is not a function` / property `mediaAutoDownload` missing.

- [ ] **Step 3: Implement the store changes**

In `apps/fluux/src/stores/settingsStore.ts`:

Add the type after the existing `TimeFormat` type (near line 4):

```ts
export type MediaAutoDownload = 'always' | 'private-only' | 'never'
```

Add to the `SettingsState` interface (after the `fontSize` members):

```ts
  mediaAutoDownload: MediaAutoDownload
  setMediaAutoDownload: (value: MediaAutoDownload) => void
```

Add the localStorage key constant (next to the other key consts):

```ts
const MEDIA_AUTO_DOWNLOAD_KEY = 'fluux-media-autodownload'
```

Add the initializer (next to `getInitialFontSize`):

```ts
/**
 * Get initial media auto-download policy from localStorage, default to 'private-only'.
 */
function getInitialMediaAutoDownload(): MediaAutoDownload {
  try {
    const stored = localStorage.getItem(MEDIA_AUTO_DOWNLOAD_KEY)
    if (stored === 'always' || stored === 'private-only' || stored === 'never') {
      return stored
    }
  } catch {
    // localStorage not available
  }
  return 'private-only'
}
```

Add to the store creator (inside `create<SettingsState>((set) => ({ ... }))`, after the `setFontSize` block):

```ts
  mediaAutoDownload: getInitialMediaAutoDownload(),

  setMediaAutoDownload: (value) => {
    try {
      localStorage.setItem(MEDIA_AUTO_DOWNLOAD_KEY, value)
    } catch {
      // localStorage not available
    }
    set({ mediaAutoDownload: value })
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/stores/settingsStore.test.ts`
Expected: PASS (all settingsStore tests, including the new block).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/stores/settingsStore.ts apps/fluux/src/stores/settingsStore.test.ts
git commit -m "feat(settings): add mediaAutoDownload preference (default private-only)"
```

---

## Task 2: Pure `computeMediaAutoload` helper + session set

**Files:**
- Create: `apps/fluux/src/utils/mediaAutoload.ts`
- Test: `apps/fluux/src/utils/mediaAutoload.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/utils/mediaAutoload.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  computeMediaAutoload,
  approveMediaUrl,
  isMediaUrlApproved,
  __resetApprovedMediaUrlsForTest,
  type ConversationTrust,
} from './mediaAutoload'

describe('computeMediaAutoload', () => {
  const trusts: ConversationTrust[] = ['direct-contact', 'direct-stranger', 'room-private', 'room-public']

  it('strangers never auto-load, under any policy', () => {
    expect(computeMediaAutoload('always', 'direct-stranger')).toBe(false)
    expect(computeMediaAutoload('private-only', 'direct-stranger')).toBe(false)
    expect(computeMediaAutoload('never', 'direct-stranger')).toBe(false)
  })

  it('always loads non-strangers under "always"', () => {
    for (const t of trusts.filter((x) => x !== 'direct-stranger')) {
      expect(computeMediaAutoload('always', t)).toBe(true)
    }
  })

  it('never loads anything under "never"', () => {
    for (const t of trusts) {
      expect(computeMediaAutoload('never', t)).toBe(false)
    }
  })

  it('private-only loads private contexts, defers public rooms and strangers', () => {
    expect(computeMediaAutoload('private-only', 'direct-contact')).toBe(true)
    expect(computeMediaAutoload('private-only', 'room-private')).toBe(true)
    expect(computeMediaAutoload('private-only', 'room-public')).toBe(false)
    expect(computeMediaAutoload('private-only', 'direct-stranger')).toBe(false)
  })
})

describe('session-approved media URLs', () => {
  beforeEach(() => __resetApprovedMediaUrlsForTest())

  it('round-trips an approved URL', () => {
    expect(isMediaUrlApproved('https://x/a.jpg')).toBe(false)
    approveMediaUrl('https://x/a.jpg')
    expect(isMediaUrlApproved('https://x/a.jpg')).toBe(true)
    expect(isMediaUrlApproved('https://x/b.jpg')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/mediaAutoload.test.ts`
Expected: FAIL — module `./mediaAutoload` not found.

- [ ] **Step 3: Implement the helper**

Create `apps/fluux/src/utils/mediaAutoload.ts`:

```ts
import type { MediaAutoDownload } from '@/stores/settingsStore'

/**
 * Trust level of the conversation a message belongs to. Determines, together
 * with the user's MediaAutoDownload policy, whether media auto-fetches.
 */
export type ConversationTrust =
  | 'direct-contact'   // 1:1 with a roster contact
  | 'direct-stranger'  // 1:1 with a non-contact: media NEVER auto-loads
  | 'room-private'     // members-only / hidden room
  | 'room-public'      // open / public room

/**
 * Whether media should auto-fetch on render for a conversation.
 *
 * Strangers are a hard floor: their media never auto-loads, even under the
 * 'always' policy (a direct message from an unknown JID is the strongest sign
 * of targeting). The user can always tap to load an individual item.
 */
export function computeMediaAutoload(policy: MediaAutoDownload, trust: ConversationTrust): boolean {
  if (trust === 'direct-stranger') return false
  if (policy === 'always') return true
  if (policy === 'never') return false
  // 'private-only': load everywhere except public rooms.
  return trust !== 'room-public'
}

/**
 * URLs the user explicitly tapped to load this session. Mirrors the
 * module-level `failedUrlCache` in FileAttachments: survives bubble
 * unmount/remount during scroll, but not an app restart.
 */
const approvedUrls = new Set<string>()
export function approveMediaUrl(url: string): void { approvedUrls.add(url) }
export function isMediaUrlApproved(url: string): boolean { return approvedUrls.has(url) }

/** Test-only: clear the session set between tests. */
export function __resetApprovedMediaUrlsForTest(): void { approvedUrls.clear() }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/mediaAutoload.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/mediaAutoload.ts apps/fluux/src/utils/mediaAutoload.test.ts
git commit -m "feat(media): add computeMediaAutoload policy helper + session approval set"
```

---

## Task 3: `MediaAutoloadContext`

**Files:**
- Create: `apps/fluux/src/contexts/MediaAutoloadContext.tsx`
- Test: `apps/fluux/src/contexts/MediaAutoloadContext.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/contexts/MediaAutoloadContext.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MediaAutoloadProvider, useMediaAutoload } from './MediaAutoloadContext'

function Probe() {
  return <span>{useMediaAutoload() ? 'auto' : 'defer'}</span>
}

describe('MediaAutoloadContext', () => {
  it('defaults to auto-load (true) with no provider', () => {
    render(<Probe />)
    expect(screen.getByText('auto')).toBeInTheDocument()
  })

  it('uses the provider value when wrapped', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <Probe />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('defer')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/contexts/MediaAutoloadContext.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the context**

Create `apps/fluux/src/contexts/MediaAutoloadContext.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from 'react'

/**
 * Whether media (images, video, audio, text previews, link-preview images)
 * should auto-fetch on render in the current conversation subtree.
 *
 * Defaults to `true` (today's behaviour) when no provider is present, so
 * components rendered outside a conversation view (e.g. SearchContextView,
 * unit tests) keep auto-loading. RoomView/ChatView wrap their message list
 * with a computed value.
 */
const MediaAutoloadContext = createContext<boolean>(true)

export function MediaAutoloadProvider({ autoLoad, children }: { autoLoad: boolean; children: ReactNode }) {
  return <MediaAutoloadContext.Provider value={autoLoad}>{children}</MediaAutoloadContext.Provider>
}

export function useMediaAutoload(): boolean {
  return useContext(MediaAutoloadContext)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/contexts/MediaAutoloadContext.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/contexts/MediaAutoloadContext.tsx apps/fluux/src/contexts/MediaAutoloadContext.test.tsx
git commit -m "feat(media): add MediaAutoloadContext (defaults to auto-load)"
```

---

## Task 4: `DeferredMediaPlaceholder` component

**Files:**
- Create: `apps/fluux/src/components/DeferredMediaPlaceholder.tsx`
- Test: `apps/fluux/src/components/DeferredMediaPlaceholder.test.tsx`

Presentational only — takes a pre-formatted `sizeLabel` string so it has no `@/hooks` dependency.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/components/DeferredMediaPlaceholder.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Image as ImageIcon } from 'lucide-react'
import { DeferredMediaPlaceholder } from './DeferredMediaPlaceholder'

describe('DeferredMediaPlaceholder', () => {
  it('renders label and size, fires onLoad on click', () => {
    const onLoad = vi.fn()
    render(
      <DeferredMediaPlaceholder variant="box" icon={ImageIcon} label="Load image" sizeLabel="1.2 MB" onLoad={onLoad} />,
    )
    expect(screen.getByText('Load image')).toBeInTheDocument()
    expect(screen.getByText('1.2 MB')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('omits size when no sizeLabel given (card variant)', () => {
    render(<DeferredMediaPlaceholder variant="card" icon={ImageIcon} label="Load audio" onLoad={() => {}} />)
    expect(screen.getByText('Load audio')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/DeferredMediaPlaceholder.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `apps/fluux/src/components/DeferredMediaPlaceholder.tsx`:

```tsx
import type { LucideIcon } from 'lucide-react'
import { Download } from 'lucide-react'

interface DeferredMediaPlaceholderProps {
  /** 'box' reserves an aspect-ratio area (image/video); 'card' is a compact row (audio/text). */
  variant: 'box' | 'card'
  icon: LucideIcon
  /** Action label, e.g. "Load image". */
  label: string
  /** Pre-formatted size string, e.g. "1.2 MB". Optional. */
  sizeLabel?: string
  /** Box variant only: reserve the loaded media's aspect ratio to avoid layout shift. */
  aspectRatio?: number
  /** Box variant only: max width in px. */
  maxWidthPx?: number
  onLoad: () => void
}

/**
 * Tap-to-load placeholder shown in place of media that is not auto-fetched
 * (public rooms / strangers / "never" policy). Loading nothing remote, it
 * leaks no IP until the user explicitly taps.
 */
export function DeferredMediaPlaceholder({
  variant, icon: Icon, label, sizeLabel, aspectRatio, maxWidthPx, onLoad,
}: DeferredMediaPlaceholderProps) {
  if (variant === 'box') {
    return (
      <button
        type="button"
        onClick={onLoad}
        className="mt-2 w-full flex flex-col items-center justify-center gap-2 rounded-lg bg-fluux-hover/60 border border-fluux-border hover:bg-fluux-hover transition-colors text-fluux-muted"
        style={{
          aspectRatio: aspectRatio ?? 4 / 3,
          maxWidth: maxWidthPx ? `${maxWidthPx}px` : '384px',
          maxHeight: '300px',
          minHeight: '100px',
        }}
      >
        <Icon className="size-6" />
        <span className="text-sm font-medium">{label}</span>
        {sizeLabel && <span className="text-xs">{sizeLabel}</span>}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onLoad}
      className="mt-2 w-full max-w-sm flex items-center gap-3 p-3 rounded-lg bg-fluux-bg/60 border border-fluux-border hover:bg-fluux-hover/60 transition-colors text-start group/file"
    >
      <div className="size-10 rounded-lg bg-fluux-muted/20 text-fluux-muted flex items-center justify-center flex-shrink-0">
        <Icon className="size-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-fluux-text truncate">{label}</p>
        {sizeLabel && <p className="text-xs text-fluux-muted">{sizeLabel}</p>}
      </div>
      <Download className="size-4 text-fluux-muted flex-shrink-0" />
    </button>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/DeferredMediaPlaceholder.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/DeferredMediaPlaceholder.tsx apps/fluux/src/components/DeferredMediaPlaceholder.test.tsx
git commit -m "feat(media): add DeferredMediaPlaceholder tap-to-load component"
```

---

## Task 5: Gate image / video / audio in FileAttachments.tsx

**Files:**
- Modify: `apps/fluux/src/components/FileAttachments.tsx`
- Test: `apps/fluux/src/components/FileAttachments.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/FileAttachments.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageAttachment } from './FileAttachments'
import { MediaAutoloadProvider } from '@/contexts/MediaAutoloadContext'
import { __resetApprovedMediaUrlsForTest } from '@/utils/mediaAutoload'

// useAttachmentUrl is the fetch seam; assert it is disabled while deferred.
const useAttachmentUrl = vi.fn()
vi.mock('@/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks')>()),
  useAttachmentUrl: (url: string | undefined, enc: unknown, enabled: boolean) => {
    useAttachmentUrl(url, enc, enabled)
    return { url: enabled ? 'blob:loaded' : null, isLoading: false, error: null }
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

// Isolate ImageAttachment from heavy children rendered on the success path.
vi.mock('./ImageLightbox', () => ({ ImageLightbox: () => null }))
vi.mock('./ImageContextMenu', () => ({ ImageContextMenu: () => null }))

const imageAttachment = { url: 'https://x/a.jpg', name: 'a.jpg', mediaType: 'image/jpeg', size: 1234, width: 800, height: 600 }

describe('ImageAttachment deferral', () => {
  beforeEach(() => {
    useAttachmentUrl.mockClear()
    __resetApprovedMediaUrlsForTest()
  })

  it('defers (placeholder, no fetch) when autoLoad is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={imageAttachment} />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('chat.loadImage')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    // fetch hook called with enabled=false
    expect(useAttachmentUrl).toHaveBeenLastCalledWith('https://x/a.jpg', undefined, false)
  })

  it('loads inline after the user taps', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={imageAttachment} />
      </MediaAutoloadProvider>,
    )
    fireEvent.click(screen.getByText('chat.loadImage'))
    expect(useAttachmentUrl).toHaveBeenLastCalledWith('https://x/a.jpg', undefined, true)
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('auto-loads when autoLoad is true (default)', () => {
    render(<ImageAttachment attachment={imageAttachment} />)
    expect(screen.queryByText('chat.loadImage')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toBeInTheDocument()
  })
})
```

> Note: `imageAttachment.url` has no thumbnail, so `originalImageSrc === attachment.url`. The assertion uses that URL.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx`
Expected: FAIL — `chat.loadImage` not found (gating not implemented).

- [ ] **Step 3: Implement gating in `ImageAttachment`**

In `apps/fluux/src/components/FileAttachments.tsx`:

Update the imports at the top:

```tsx
import { useState, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Music, Film, FileText, Archive, File, Download, BookOpen, Loader2, ImageOff, FileX, Image as ImageIcon } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { ImageLightbox } from './ImageLightbox'
import { ImageContextMenu } from './ImageContextMenu'
import { DeferredMediaPlaceholder } from './DeferredMediaPlaceholder'
import { formatBytes, useAttachmentUrl } from '@/hooks'
import { useContextMenu } from '@/hooks/useContextMenu'
import { useMediaAutoload } from '@/contexts/MediaAutoloadContext'
import { approveMediaUrl, isMediaUrlApproved } from '@/utils/mediaAutoload'
import { isPdfMimeType, isDocumentMimeType, isArchiveMimeType, isEbookMimeType, getFileTypeLabel } from '@/utils/thumbnail'
import type { FileAttachment } from '@fluux/sdk'
```

In `ImageAttachment`, add the autoload hooks right after the existing `loadError` state (after line ~51) and change the `useAttachmentUrl` enabled arg:

```tsx
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(originalImageSrc))

  // Public-room / stranger gating: defer the remote fetch until the user taps,
  // unless the conversation policy auto-loads. Manual approval persists for the
  // session so scroll unmount/remount keeps it loaded.
  const autoLoad = useMediaAutoload()
  const [mediaApproved, setMediaApproved] = useState(() => isMediaUrlApproved(originalImageSrc))
  const shouldLoad = autoLoad || mediaApproved

  const { url: proxiedImageSrc, isLoading, error } = useAttachmentUrl(
    originalImageSrc,
    originalEncryption,
    isImage && shouldLoad,
  )
```

Then add the placeholder branch after the `maxWidthPx` computation (after line ~86, before the `if (isLoading)` block):

```tsx
  // Deferred: show a tap-to-load placeholder that reserves the image box.
  if (isImage && !shouldLoad) {
    return (
      <DeferredMediaPlaceholder
        variant="box"
        icon={ImageIcon}
        label={t('chat.loadImage')}
        sizeLabel={attachment.size ? formatBytes(attachment.size) : undefined}
        aspectRatio={aspectRatio}
        maxWidthPx={maxWidthPx}
        onLoad={() => { approveMediaUrl(originalImageSrc); setMediaApproved(true) }}
      />
    )
  }
```

- [ ] **Step 4: Implement gating in `VideoAttachment`**

Add the autoload hooks after the existing `loadError` state (after line ~198) and change the main `useAttachmentUrl` enabled args:

```tsx
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(attachment.url))

  const autoLoad = useMediaAutoload()
  const [mediaApproved, setMediaApproved] = useState(() => isMediaUrlApproved(attachment.url))
  const shouldLoad = autoLoad || mediaApproved

  const { url: proxiedVideoUrl, isLoading, error } = useAttachmentUrl(
    attachment.url,
    attachment.encryption,
    isVideo && shouldLoad,
  )
  const { url: proxiedPosterUrl } = useAttachmentUrl(
    attachment.thumbnail?.uri,
    attachment.thumbnail?.encryption,
    isVideo && shouldLoad && !!attachment.thumbnail?.uri,
  )
```

Add the placeholder branch after the `containerStyle` computation (after line ~230, before the `if (isLoading)` block):

```tsx
  if (isVideo && !shouldLoad) {
    return (
      <DeferredMediaPlaceholder
        variant="box"
        icon={Film}
        label={t('chat.loadVideo')}
        sizeLabel={attachment.size ? formatBytes(attachment.size) : undefined}
        aspectRatio={aspectRatio}
        maxWidthPx={448}
        onLoad={() => { approveMediaUrl(attachment.url); setMediaApproved(true) }}
      />
    )
  }
```

- [ ] **Step 5: Implement gating in `AudioAttachment`**

Add the autoload hooks after the existing `loadError` state (after line ~330) and change the `useAttachmentUrl` enabled arg:

```tsx
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(attachment.url))

  const autoLoad = useMediaAutoload()
  const [mediaApproved, setMediaApproved] = useState(() => isMediaUrlApproved(attachment.url))
  const shouldLoad = autoLoad || mediaApproved

  const { url: proxiedAudioUrl, isLoading, error } = useAttachmentUrl(
    attachment.url,
    attachment.encryption,
    isAudio && shouldLoad,
  )
```

Add the placeholder branch right after `if (!isAudio) return null` (after line ~343):

```tsx
  if (!shouldLoad) {
    return (
      <DeferredMediaPlaceholder
        variant="card"
        icon={Music}
        label={t('chat.loadAudio')}
        sizeLabel={attachment.size ? formatBytes(attachment.size) : undefined}
        onLoad={() => { approveMediaUrl(attachment.url); setMediaApproved(true) }}
      />
    )
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx`
Expected: PASS (all three deferral tests).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/FileAttachments.tsx apps/fluux/src/components/FileAttachments.test.tsx
git commit -m "feat(media): gate image/video/audio auto-fetch behind media-autoload policy"
```

---

## Task 6: Gate TextFilePreview.tsx

**Files:**
- Modify: `apps/fluux/src/components/TextFilePreview.tsx`

`useTextPreview(url, enabled)` already has an `enabled` gate, so this is a small change plus a deferred card.

- [ ] **Step 1: Implement gating**

In `apps/fluux/src/components/TextFilePreview.tsx`:

Update imports:

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Download, Loader2 } from 'lucide-react'
import { useTextPreview, formatBytes } from '@/hooks'
import { DeferredMediaPlaceholder } from './DeferredMediaPlaceholder'
import { useMediaAutoload } from '@/contexts/MediaAutoloadContext'
import { approveMediaUrl, isMediaUrlApproved } from '@/utils/mediaAutoload'
import { canPreviewAsText, getFileTypeLabel } from '@/utils/thumbnail'
import type { FileAttachment } from '@fluux/sdk'
```

Replace the body up to the `if (!canPreview) return null` line:

```tsx
export function TextFilePreview({ attachment, isSelected = false, isHovered = false }: TextFilePreviewProps) {
  const { t } = useTranslation()
  const canPreview = canPreviewAsText(attachment.mediaType, attachment.name)

  const autoLoad = useMediaAutoload()
  const [mediaApproved, setMediaApproved] = useState(() => isMediaUrlApproved(attachment.url))
  const shouldLoad = autoLoad || mediaApproved

  const { content, isLoading, error, isTruncated } = useTextPreview(
    attachment.url,
    canPreview && shouldLoad,
  )

  // Don't render anything if this isn't a text file
  if (!canPreview) return null

  // Deferred: tap to load the text preview.
  if (!shouldLoad) {
    return (
      <DeferredMediaPlaceholder
        variant="card"
        icon={FileText}
        label={t('chat.loadFilePreview')}
        sizeLabel={attachment.size ? formatBytes(attachment.size) : undefined}
        onLoad={() => { approveMediaUrl(attachment.url); setMediaApproved(true) }}
      />
    )
  }

  return (
```

(The rest of the component — the preview `<div>` and download card — is unchanged.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors from the edit).

- [ ] **Step 3: Run the text-preview related tests (regression)**

Run: `cd apps/fluux && npx vitest run src/components/MessageAttachments.test.tsx src/utils/thumbnail.test.ts 2>/dev/null; cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx`
Expected: PASS (no regressions; if a file does not exist, vitest reports "no test files" — that is fine, the FileAttachments suite must pass).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/TextFilePreview.tsx
git commit -m "feat(media): gate text-file preview fetch behind media-autoload policy"
```

---

## Task 7: Gate the link-preview OG image

**Files:**
- Modify: `apps/fluux/src/components/LinkPreviewCard.tsx`
- Test: `apps/fluux/src/components/LinkPreviewCard.test.tsx` (extend existing)

Only the `<img src={preview.image}>` fetches remotely; the title/description/domain arrive inline and always render. The card is an `<a>`, so the deferred control is a `div role="button"` that stops anchor navigation.

- [ ] **Step 1: Write the failing test**

Append to `apps/fluux/src/components/LinkPreviewCard.test.tsx` (inside the top-level describe; add imports at the top of the file if missing):

```tsx
import { MediaAutoloadProvider } from '@/contexts/MediaAutoloadContext'
import { __resetApprovedMediaUrlsForTest } from '@/utils/mediaAutoload'

describe('LinkPreviewCard image deferral', () => {
  beforeEach(() => __resetApprovedMediaUrlsForTest())
  const preview = { url: 'https://ex.com/p', title: 'T', description: 'D', image: 'https://ex.com/og.png', siteName: 'Ex' }

  it('hides the OG image and shows a tap-to-load control when autoLoad is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <LinkPreviewCard preview={preview} />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('T')).toBeInTheDocument()            // text still renders
    expect(screen.queryByRole('img')).not.toBeInTheDocument()    // image suppressed
    expect(screen.getByText('chat.showLinkImage')).toBeInTheDocument()
  })

  it('shows the image after tapping the control', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <LinkPreviewCard preview={preview} />
      </MediaAutoloadProvider>,
    )
    fireEvent.click(screen.getByText('chat.showLinkImage'))
    expect(screen.getByRole('img')).toBeInTheDocument()
  })
})
```

> If `LinkPreviewCard.test.tsx` does not mock `react-i18next`, add at the top:
> `vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))`
> and ensure `render, screen, fireEvent` are imported from `@testing-library/react` and `describe, it, expect, beforeEach, vi` from `vitest`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/LinkPreviewCard.test.tsx`
Expected: FAIL — `chat.showLinkImage` not found.

- [ ] **Step 3: Implement gating**

In `apps/fluux/src/components/LinkPreviewCard.tsx`:

Update imports:

```tsx
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Image as ImageIcon } from 'lucide-react'
import { useMediaAutoload } from '@/contexts/MediaAutoloadContext'
import { approveMediaUrl, isMediaUrlApproved } from '@/utils/mediaAutoload'
import type { LinkPreview } from '@fluux/sdk'
```

Add inside the component, after the existing `retryTimer` ref / state declarations (after line ~26):

```tsx
  const { t } = useTranslation()
  const autoLoad = useMediaAutoload()
  const [imageApproved, setImageApproved] = useState(() => preview.image ? isMediaUrlApproved(preview.image) : false)
  const showImage = autoLoad || imageApproved
```

Replace the image block (`{preview.image && imagePhase !== 'gone' && ( ... )}`) with a version gated on `showImage`, plus a deferred control:

```tsx
      {/* OG image — fetched only when policy/tap allows; deferred control otherwise. */}
      {preview.image && showImage && imagePhase !== 'gone' && (
        <div className="aspect-video bg-fluux-bg/80 overflow-hidden">
          {imagePhase === 'showing' && (
            <img
              key={attempt}
              src={preview.image}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
              onLoad={onLoad}
              onError={handleImageError}
            />
          )}
        </div>
      )}
      {preview.image && !showImage && (
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (preview.image) approveMediaUrl(preview.image); setImageApproved(true) }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (preview.image) approveMediaUrl(preview.image); setImageApproved(true) } }}
          className="aspect-video bg-fluux-hover/60 hover:bg-fluux-hover flex flex-col items-center justify-center gap-2 text-fluux-muted transition-colors cursor-pointer"
        >
          <ImageIcon className="size-6" />
          <span className="text-sm font-medium">{t('chat.showLinkImage')}</span>
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/LinkPreviewCard.test.tsx`
Expected: PASS (new deferral tests + existing tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/LinkPreviewCard.tsx apps/fluux/src/components/LinkPreviewCard.test.tsx
git commit -m "feat(media): gate link-preview OG image behind media-autoload policy"
```

---

## Task 8: Provide the context from ChatView and RoomView

**Files:**
- Modify: `apps/fluux/src/components/ChatView.tsx`
- Modify: `apps/fluux/src/components/RoomView.tsx`

- [ ] **Step 1: Wire ChatView**

In `apps/fluux/src/components/ChatView.tsx`:

Add imports (after the existing app-local imports, e.g. near the `./conversation` import line ~14):

```tsx
import { MediaAutoloadProvider } from '@/contexts/MediaAutoloadContext'
import { computeMediaAutoload } from '@/utils/mediaAutoload'
import { useSettingsStore } from '@/stores/settingsStore'
```

Add the policy hook near the other top-level hooks (above the `if (!activeConversation) return null` at line ~323), for example right after the `useChatActive()` / `useContactIdentities()` lines:

```tsx
  const mediaPolicy = useSettingsStore((s) => s.mediaAutoDownload)
```

After the existing `contact` computation (line ~326-328, which is below the early return), compute the autoload flag:

```tsx
  // 1:1 media trust: a peer absent from the roster contacts map is a stranger
  // (matches the SDK's roster.hasContact stranger definition). Strangers never
  // auto-load regardless of policy.
  const mediaAutoLoad = computeMediaAutoload(
    mediaPolicy,
    activeConversation.type === 'chat' && !contactsByJid.has(activeConversation.id)
      ? 'direct-stranger'
      : 'direct-contact',
  )
```

Wrap the `<ChatMessageList ... />` element (line ~420) in the provider:

```tsx
        <MediaAutoloadProvider autoLoad={mediaAutoLoad}>
          <ChatMessageList
            messages={activeMessages}
            /* ...existing props unchanged... */
          />
        </MediaAutoloadProvider>
```

- [ ] **Step 2: Wire RoomView**

In `apps/fluux/src/components/RoomView.tsx`:

Add imports (near the other app-local imports, e.g. after the `./conversation` import line ~8):

```tsx
import { MediaAutoloadProvider } from '@/contexts/MediaAutoloadContext'
import { computeMediaAutoload } from '@/utils/mediaAutoload'
import { useSettingsStore } from '@/stores/settingsStore'
```

Add the policy hook near the other top-level hooks (above `if (!activeRoom) return null` at line ~433), e.g. right after the `useRoomActive()` destructuring at line ~77:

```tsx
  const mediaPolicy = useSettingsStore((s) => s.mediaAutoDownload)
```

After the early return (line ~433), compute the flag (place just before the `return (` at line ~435):

```tsx
  // Room media trust: open rooms are public; members-only/hidden are private.
  // A room whose disco hasn't resolved has isPrivate falsy → treated as public
  // (fail-safe). Strangers do not apply to rooms.
  const mediaAutoLoad = computeMediaAutoload(mediaPolicy, activeRoom.isPrivate ? 'room-private' : 'room-public')
```

Wrap the `<RoomMessageList ... />` element (line ~501) in the provider:

```tsx
          <MediaAutoloadProvider autoLoad={mediaAutoLoad}>
            <RoomMessageList
              messages={displayMessages}
              /* ...existing props unchanged... */
            />
          </MediaAutoloadProvider>
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the view test suites (regression)**

Run: `cd apps/fluux && npx vitest run src/components/ChatView.test.tsx src/components/RoomView.test.tsx`
Expected: PASS. If a test fails because `useContactIdentities`/`useSettingsStore` are not provided, ensure the test's `@fluux/sdk` mock returns a `Map` from `useContactIdentities` and that `settingsStore` (a real store) initializes; do not add new mock surface beyond what already exists.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/RoomView.tsx
git commit -m "feat(media): provide media-autoload context from ChatView and RoomView"
```

---

## Task 9: Privacy settings category + PrivacySettings panel + English i18n

**Files:**
- Create: `apps/fluux/src/components/settings-components/PrivacySettings.tsx`
- Modify: `apps/fluux/src/components/settings-components/types.ts`
- Modify: `apps/fluux/src/components/settings-components/index.ts`
- Modify: `apps/fluux/src/components/SettingsView.tsx`
- Modify: `apps/fluux/src/i18n/locales/en.json`

- [ ] **Step 1: Add the English i18n keys**

In `apps/fluux/src/i18n/locales/en.json`, add under the existing `"settings"."categories"` object:

```json
        "privacy": "Privacy"
```

Add under the `"settings"` object (next to `timeFormat*` keys):

```json
    "mediaAutoDownload": "Auto-download media",
    "mediaAutoDownloadDescription": "Choose when images, videos, and files load automatically.",
    "mediaAutoDownloadAlways": "Always",
    "mediaAutoDownloadAlwaysDescription": "Load media automatically in every conversation.",
    "mediaAutoDownloadPrivateOnly": "Private only",
    "mediaAutoDownloadPrivateOnlyDescription": "Load automatically in direct messages and private rooms. In public channels, tap to load.",
    "mediaAutoDownloadNever": "Never",
    "mediaAutoDownloadNeverDescription": "Never load media automatically. Tap to load in any conversation.",
    "mediaAutoDownloadStrangerNote": "Media from people who aren't in your contacts always needs a tap to load, whatever you choose here."
```

Add under the existing `"chat"` object:

```json
    "loadImage": "Load image",
    "loadVideo": "Load video",
    "loadAudio": "Load audio",
    "loadFilePreview": "Load preview",
    "showLinkImage": "Show image"
```

> Place keys so the file stays valid JSON (watch trailing commas). Verify: `node -e "JSON.parse(require('fs').readFileSync('apps/fluux/src/i18n/locales/en.json','utf8')); console.log('en.json OK')"`

- [ ] **Step 2: Add the `privacy` category to types.ts**

In `apps/fluux/src/components/settings-components/types.ts`:

Update the lucide import to include `ShieldCheck`:

```ts
import { User, Palette, Globe, Bell, Download, Ban, HardDrive, Lock, ShieldCheck } from 'lucide-react'
```

Add `'privacy'` to the `SettingsCategory` union:

```ts
export type SettingsCategory =
  | 'profile'
  | 'appearance'
  | 'language'
  | 'notifications'
  | 'privacy'
  | 'updates'
  | 'blocked'
  | 'storage'
  | 'encryption'
```

Add the entry to `SETTINGS_CATEGORIES` (after the `notifications` entry):

```ts
  { id: 'privacy', labelKey: 'settings.categories.privacy', icon: ShieldCheck },
```

- [ ] **Step 3: Create the PrivacySettings panel**

Create `apps/fluux/src/components/settings-components/PrivacySettings.tsx`:

```tsx
import { useTranslation } from 'react-i18next'
import { useSettingsStore, type MediaAutoDownload } from '@/stores/settingsStore'

const mediaOptions: { value: MediaAutoDownload; labelKey: string; descriptionKey: string }[] = [
  { value: 'always', labelKey: 'settings.mediaAutoDownloadAlways', descriptionKey: 'settings.mediaAutoDownloadAlwaysDescription' },
  { value: 'private-only', labelKey: 'settings.mediaAutoDownloadPrivateOnly', descriptionKey: 'settings.mediaAutoDownloadPrivateOnlyDescription' },
  { value: 'never', labelKey: 'settings.mediaAutoDownloadNever', descriptionKey: 'settings.mediaAutoDownloadNeverDescription' },
]

export function PrivacySettings() {
  const { t } = useTranslation()
  const mediaAutoDownload = useSettingsStore((s) => s.mediaAutoDownload)
  const setMediaAutoDownload = useSettingsStore((s) => s.setMediaAutoDownload)

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.categories.privacy')}
      </h3>

      <div className="space-y-3">
        <label className="text-sm font-medium text-fluux-text">{t('settings.mediaAutoDownload')}</label>
        <p className="text-xs text-fluux-muted">{t('settings.mediaAutoDownloadDescription')}</p>
        <div className="grid grid-cols-3 gap-3">
          {mediaOptions.map((option) => {
            const isSelected = mediaAutoDownload === option.value
            return (
              <button
                key={option.value}
                onClick={() => setMediaAutoDownload(option.value)}
                className={`flex items-center justify-center gap-2 p-3 rounded-lg border-2 transition-all
                  ${isSelected
                    ? 'border-fluux-brand bg-fluux-brand/10'
                    : 'border-fluux-hover bg-fluux-bg hover:border-fluux-muted'
                  }`}
              >
                <span className={`text-sm font-medium ${isSelected ? 'text-fluux-text' : 'text-fluux-muted'}`}>
                  {t(option.labelKey)}
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-fluux-muted mt-2">
          {t(mediaOptions.find((o) => o.value === mediaAutoDownload)?.descriptionKey || '')}
        </p>
        <p className="text-xs text-fluux-muted border-t border-fluux-border pt-3 mt-3">
          {t('settings.mediaAutoDownloadStrangerNote')}
        </p>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Export and route it**

In `apps/fluux/src/components/settings-components/index.ts`, add (after the `StorageSettings` export):

```ts
export { PrivacySettings } from './PrivacySettings'
```

In `apps/fluux/src/components/SettingsView.tsx`, add `PrivacySettings` to the import from `./settings-components`, and add a case in `renderContent()` (after the `notifications` case):

```tsx
      case 'privacy':
        return <PrivacySettings />
```

- [ ] **Step 5: Typecheck + run settings/related tests**

Run: `npm run typecheck`
Expected: PASS.

Run: `cd apps/fluux && npx vitest run src/components/SettingsView.test.tsx 2>/dev/null; cd apps/fluux && npx vitest run src/stores/settingsStore.test.ts`
Expected: PASS (settingsStore passes; SettingsView passes if such a test exists).

- [ ] **Step 6: Manual smoke (dev server)**

Verify via the preview workflow: open Settings → Privacy, confirm the three-option control renders, switching persists (reload keeps the choice), and the stranger note is visible.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/settings-components/PrivacySettings.tsx \
  apps/fluux/src/components/settings-components/types.ts \
  apps/fluux/src/components/settings-components/index.ts \
  apps/fluux/src/components/SettingsView.tsx \
  apps/fluux/src/i18n/locales/en.json
git commit -m "feat(settings): add Privacy category with media auto-download control"
```

---

## Task 10: Translate the new i18n keys into the other 32 locales

**Files:**
- Modify: every `apps/fluux/src/i18n/locales/<lang>.json` except `en.json`.

The new keys are: `settings.categories.privacy`; `settings.mediaAutoDownload`, `…Description`, `…Always`, `…AlwaysDescription`, `…PrivateOnly`, `…PrivateOnlyDescription`, `…Never`, `…NeverDescription`, `…StrangerNote`; `chat.loadImage`, `chat.loadVideo`, `chat.loadAudio`, `chat.loadFilePreview`, `chat.showLinkImage`.

- [ ] **Step 1: List the locale files to edit**

Run: `ls apps/fluux/src/i18n/locales/ | grep -v '^en.json$'`
Expected: 32 files (ar, be, bg, ca, cs, da, de, el, es, et, fi, fr, ga, he, hr, hu, is, it, lt, lv, mt, nb, nl, pl, pt, ro, ru, sk, sl, sv, uk, zh-CN).

- [ ] **Step 2: Add translated keys to each locale**

For each locale file, insert the same keys in the same positions as in `en.json` (`settings.categories.privacy`; the `settings.mediaAutoDownload*` block; the `chat.load*`/`chat.showLinkImage` block), with values translated for that language. Match each file's existing tone and key ordering. **Do not use em-dash (`—`/`–`) as a clause connector** — use a period + capital, comma, or colon (project convention).

French (`fr.json`) reference values:

```json
"settings.categories.privacy"                     → "Confidentialité"
"settings.mediaAutoDownload"                       → "Téléchargement automatique des médias"
"settings.mediaAutoDownloadDescription"            → "Choisissez quand les images, vidéos et fichiers se chargent automatiquement."
"settings.mediaAutoDownloadAlways"                 → "Toujours"
"settings.mediaAutoDownloadAlwaysDescription"      → "Charger les médias automatiquement dans toutes les conversations."
"settings.mediaAutoDownloadPrivateOnly"            → "Privé uniquement"
"settings.mediaAutoDownloadPrivateOnlyDescription" → "Charger automatiquement dans les messages directs et les salons privés. Dans les salons publics, touchez pour charger."
"settings.mediaAutoDownloadNever"                  → "Jamais"
"settings.mediaAutoDownloadNeverDescription"       → "Ne jamais charger les médias automatiquement. Touchez pour charger dans toute conversation."
"settings.mediaAutoDownloadStrangerNote"           → "Les médias des personnes absentes de vos contacts nécessitent toujours une action pour se charger, quel que soit ce réglage."
"chat.loadImage"                                   → "Charger l'image"
"chat.loadVideo"                                   → "Charger la vidéo"
"chat.loadAudio"                                   → "Charger l'audio"
"chat.loadFilePreview"                             → "Charger l'aperçu"
"chat.showLinkImage"                               → "Afficher l'image"
```

(These belong in the nested `settings`/`settings.categories`/`chat` objects, not as flat dotted keys.)

- [ ] **Step 3: Verify every locale has the keys and stays valid JSON**

Run:

```bash
cd apps/fluux/src/i18n/locales
for f in *.json; do
  node -e "
    const o = JSON.parse(require('fs').readFileSync('$f','utf8'));
    const miss = [];
    if (!o.settings?.categories?.privacy) miss.push('categories.privacy');
    for (const k of ['mediaAutoDownload','mediaAutoDownloadAlways','mediaAutoDownloadPrivateOnly','mediaAutoDownloadNever','mediaAutoDownloadStrangerNote']) if (!o.settings?.[k]) miss.push('settings.'+k);
    for (const k of ['loadImage','loadVideo','loadAudio','loadFilePreview','showLinkImage']) if (!o.chat?.[k]) miss.push('chat.'+k);
    if (miss.length) { console.error('$f MISSING:', miss.join(', ')); process.exit(1); }
  " || exit 1
done
echo 'all locales OK'
```

Expected: `all locales OK`.

- [ ] **Step 4: Scan new values for em-dash connectors**

Run: `grep -lnE '[—–]' apps/fluux/src/i18n/locales/*.json | head` then inspect any hit's new lines; replace em-dash connectors in the keys you added.
Expected: none of the *newly added* values use `—`/`–` as a connector.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales/
git commit -m "i18n: translate media auto-download settings into all locales"
```

---

## Task 11: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS (no new errors/warnings in changed files).

- [ ] **Step 3: Full test suite (per-workspace, no stderr)**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no unhandled errors/stderr. (Run the SDK workspace too if anything there was touched — it was not, so app workspace is sufficient.)

- [ ] **Step 4: Demo verification**

Start the dev server and verify in demo mode (`http://localhost:5173/demo.html`):
- A public room with image/video attachments shows tap-to-load placeholders under the default policy; tapping loads inline; no scroll jump on swap.
- A 1:1 chat with a known contact and a private room auto-load.
- Settings → Privacy → "Always": media auto-loads in the public room; but a 1:1 from a JID not in the roster still shows placeholders (stranger floor).
- Settings → Privacy → "Never": placeholders everywhere.
Capture a screenshot of the public-room placeholder and of the loaded-after-tap state.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test: verification fixups for media auto-download"
```

(Skip if nothing changed.)

---

## Self-review notes (author)

- **Spec coverage:** policy + default (Task 1, 9); helper + stranger floor (Task 2); context default-true (Task 3); placeholder (Task 4); 5 gated surfaces — image/video/audio (Task 5), text (Task 6), link image (Task 7); view wiring incl. stranger trust via `contactsByJid.has` and room trust via `isPrivate` (Task 8); Privacy category + control + stranger note (Task 9); 33-locale i18n, no em-dash (Task 9 en + Task 10 rest); tests + demo verification (Tasks 1-11). `SearchContextView` intentionally unwrapped (default true) per spec — no task, by design.
- **Type consistency:** `MediaAutoDownload` (settingsStore) and `ConversationTrust` (mediaAutoload) are the single source types; `computeMediaAutoload(policy, trust)`, `approveMediaUrl`/`isMediaUrlApproved`, `MediaAutoloadProvider autoLoad=` / `useMediaAutoload()`, and `DeferredMediaPlaceholder` props (`variant`/`icon`/`label`/`sizeLabel`/`aspectRatio`/`maxWidthPx`/`onLoad`) are used identically across Tasks 2-9.
- **No placeholders:** every code step shows complete code; i18n translation (Task 10) is bounded by an explicit key list + per-file verification script rather than inlining 32×15 strings.
