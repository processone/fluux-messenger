# Decrypt Encrypted Attachments On Download — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Downloading any end-to-end-encrypted attachment (XEP-0454 aesgcm inside an OX message) saves the decrypted file, not ciphertext — for every file type.

**Architecture:** App-only change in `apps/fluux`. A new type-agnostic helper `downloadAttachment()` resolves the *decrypted* bytes through the same cached resolvers the inline renderers already use (`resolveEncryptedMediaUrl` on Tauri, `resolveWebEncryptedMediaUrl` on web), then hands the decrypted URL to the existing `downloadFile()`. Decryption happens on click, never on render. All download controls (file card, media info-bars, media error fallbacks) route through it.

**Tech Stack:** TypeScript, React, Vitest + @testing-library/react (jsdom), Tauri plugin-fs/plugin-dialog, WebCrypto (already wrapped by the SDK's `decryptFile`).

## Global Constraints

- No SDK change, no new cryptography. The file is AES-256-GCM (XEP-0454); the key/IV are already parsed into `attachment.encryption`.
- Detection keys **only** on `attachment.encryption` being present — never on MIME type or filename. Must work for every attachment kind.
- No eager decryption: encrypted file cards must not fetch/decrypt on render (large files, media-autoload deferral). Decrypt on click only.
- No inline preview of encrypted non-media files — download-to-disk only.
- Reuse existing modules: `downloadFile` (`apps/fluux/src/utils/download.ts`), `resolveEncryptedMediaUrl` / `resolveWebEncryptedMediaUrl` (`apps/fluux/src/utils/mediaCache.ts`), `isTauri` (`apps/fluux/src/utils/tauri.ts`), `useToastStore` (`apps/fluux/src/stores/toastStore.ts`).
- i18n: no new keys — use existing `common.download` and `common.downloadFailed`.
- Commit messages: no Claude footer.

## File Structure

- `apps/fluux/src/utils/download.ts` — **modify**: add `downloadAttachment()` alongside the existing `downloadFile()`. Shared, platform-aware, type-agnostic.
- `apps/fluux/src/utils/downloadAttachment.test.ts` — **create**: unit tests for `downloadAttachment` covering both platform branches and the error path (new file so the existing `download.test.ts` module-level `isTauri:()=>true` mock is untouched).
- `apps/fluux/src/components/AttachmentDownloadButton.tsx` — **create**: small reusable download control. Plaintext → `<a href download>` (preserves current behavior + existing tests); encrypted → `<button>` that calls `downloadAttachment` with an in-progress state.
- `apps/fluux/src/components/FileAttachments.tsx` — **modify**: `FileAttachmentCard` becomes decrypt-aware (whole-card button when encrypted); video/audio/image download controls and the image error-fallback route through the decrypt-aware path.
- `apps/fluux/src/components/FileAttachments.test.tsx` — **modify**: add encrypted-attachment coverage; keep the existing plaintext assertions passing.

## Task Ordering

1. Task 1 — `downloadAttachment()` helper (the primitive everything else calls).
2. Task 2 — `FileAttachmentCard` decrypt-aware (the primary reported bug: PDFs/docs/archives/any non-media file).
3. Task 3 — `AttachmentDownloadButton` + wire the media download controls and image error fallback.

---

### Task 1: `downloadAttachment()` helper

**Files:**
- Modify: `apps/fluux/src/utils/download.ts`
- Test: `apps/fluux/src/utils/downloadAttachment.test.ts` (create)

**Interfaces:**
- Consumes: `downloadFile(url, filename, { errorMessage })` (same module); `resolveEncryptedMediaUrl(httpsUrl, encryption)` and `resolveWebEncryptedMediaUrl(httpsUrl, encryption)` from `@/utils/mediaCache` (both `Promise<string>`, returning an `asset://`/`blob:` URL of the decrypted bytes); `isTauri()` from `./tauri`; `useToastStore` from `@/stores/toastStore`; `FileEncryption`/`FileAttachment` types from `@fluux/sdk`.
- Produces: `downloadAttachment(attachment, options?)` — used by Tasks 2 and 3.
  ```ts
  export async function downloadAttachment(
    attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>,
    options?: { errorMessage?: string },
  ): Promise<void>
  ```

- [ ] **Step 1: Write the failing test file**

Create `apps/fluux/src/utils/downloadAttachment.test.ts`:

```ts
/**
 * @vitest-environment jsdom
 *
 * downloadAttachment must decrypt encrypted attachments before saving. For a
 * plaintext attachment it delegates to downloadFile with the raw URL; for an
 * encrypted one it resolves the DECRYPTED bytes (via the platform media-cache
 * resolver) and saves those — the ciphertext URL must never reach the save path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { isTauriMock, saveMock, writeFileMock, resolveTauriMock, resolveWebMock } =
  vi.hoisted(() => ({
    isTauriMock: vi.fn(),
    saveMock: vi.fn(),
    writeFileMock: vi.fn(),
    resolveTauriMock: vi.fn(),
    resolveWebMock: vi.fn(),
  }))

vi.mock('./tauri', () => ({ isTauri: isTauriMock }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveMock }))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: writeFileMock }))
vi.mock('./mediaCache', () => ({
  resolveEncryptedMediaUrl: resolveTauriMock,
  resolveWebEncryptedMediaUrl: resolveWebMock,
}))

import { downloadAttachment } from './download'
import { useToastStore } from '@/stores/toastStore'
import type { FileEncryption } from '@fluux/sdk'

const enc: FileEncryption = {
  cipher: 'aes-256-gcm',
  key: new Uint8Array(32),
  iv: new Uint8Array(12),
}

describe('downloadAttachment', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    vi.clearAllMocks()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(4),
    }) as unknown as typeof fetch
  })

  it('Tauri: encrypted → resolves decrypted URL and saves that, never the ciphertext URL', async () => {
    isTauriMock.mockReturnValue(true)
    resolveTauriMock.mockResolvedValue('asset://localhost/decrypted.dec')
    saveMock.mockResolvedValue('/Users/me/doc.pdf')

    await downloadAttachment(
      { url: 'https://up/cipher.bin', name: 'doc.pdf', encryption: enc },
      { errorMessage: 'Download failed' },
    )

    expect(resolveTauriMock).toHaveBeenCalledWith('https://up/cipher.bin', enc)
    expect(resolveWebMock).not.toHaveBeenCalled()
    // Save dialog uses the real filename.
    expect(saveMock).toHaveBeenCalledWith({ defaultPath: 'doc.pdf' })
    // The fetch that reads the bytes to write must target the DECRYPTED url.
    expect(global.fetch).toHaveBeenCalledWith('asset://localhost/decrypted.dec')
    expect(writeFileMock).toHaveBeenCalled()
  })

  it('web: encrypted → resolves via the web resolver', async () => {
    isTauriMock.mockReturnValue(false)
    resolveWebMock.mockResolvedValue('blob:decrypted')
    const createEl = vi.spyOn(document, 'createElement')

    await downloadAttachment(
      { url: 'https://up/cipher.bin', name: 'archive.zip', encryption: enc },
    )

    expect(resolveWebMock).toHaveBeenCalledWith('https://up/cipher.bin', enc)
    expect(resolveTauriMock).not.toHaveBeenCalled()
    const anchor = createEl.mock.results
      .map((r) => r.value as HTMLElement)
      .find((el) => el instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined
    expect(anchor?.getAttribute('href')).toBe('blob:decrypted')
    expect(anchor?.getAttribute('download')).toBe('archive.zip')
  })

  it('plaintext → delegates to the raw URL, resolver not called', async () => {
    isTauriMock.mockReturnValue(true)
    saveMock.mockResolvedValue('/Users/me/note.txt')

    await downloadAttachment({ url: 'https://up/note.txt', name: 'note.txt' })

    expect(resolveTauriMock).not.toHaveBeenCalled()
    expect(resolveWebMock).not.toHaveBeenCalled()
    expect(global.fetch).toHaveBeenCalledWith('https://up/note.txt')
  })

  it('encrypted resolve failure → error toast, nothing written', async () => {
    isTauriMock.mockReturnValue(true)
    resolveTauriMock.mockRejectedValue(new Error('auth tag mismatch'))

    await downloadAttachment(
      { url: 'https://up/cipher.bin', name: 'doc.pdf', encryption: enc },
      { errorMessage: 'Download failed' },
    ).catch(() => {})

    expect(saveMock).not.toHaveBeenCalled()
    expect(writeFileMock).not.toHaveBeenCalled()
    expect(
      useToastStore.getState().toasts.some((t) => t.type === 'error' && t.message === 'Download failed'),
    ).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/downloadAttachment.test.ts`
Expected: FAIL — `downloadAttachment` is not exported from `./download`.

- [ ] **Step 3: Implement `downloadAttachment`**

In `apps/fluux/src/utils/download.ts`, add the import at the top (keep the existing imports):

```ts
import type { FileAttachment } from '@fluux/sdk'
```

Then append, after the existing `downloadFile` function:

```ts
/**
 * Download an attachment, decrypting first when it is XEP-0454 (aesgcm)
 * ciphertext. Type-agnostic: keys solely on `attachment.encryption`.
 *
 * For a plaintext attachment this is exactly `downloadFile(url, name)`. For an
 * encrypted one it resolves the DECRYPTED bytes through the same cached
 * media-cache resolver the inline renderers use (so a file already viewed
 * inline is a cache hit), then saves those bytes. The ciphertext URL is never
 * handed to the save path. Any resolve/decrypt failure (AEAD auth-tag mismatch,
 * fetch error) surfaces as the same localized error toast `downloadFile` uses.
 *
 * Decryption happens here, on the caller's click — never eagerly on render.
 */
export async function downloadAttachment(
  attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>,
  options?: { errorMessage?: string },
): Promise<void> {
  const filename = attachment.name ?? 'download'
  if (!attachment.encryption) {
    await downloadFile(attachment.url, filename, options)
    return
  }
  try {
    const { resolveEncryptedMediaUrl, resolveWebEncryptedMediaUrl } = await import('./mediaCache')
    const resolve = isTauri() ? resolveEncryptedMediaUrl : resolveWebEncryptedMediaUrl
    const decryptedUrl = await resolve(attachment.url, attachment.encryption)
    await downloadFile(decryptedUrl, filename, options)
  } catch (error) {
    console.warn('[download] Failed to decrypt attachment:', error)
    useToastStore.getState().addToast('error', options?.errorMessage ?? 'Download failed')
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/downloadAttachment.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck -w @xmpp/fluux`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/utils/download.ts apps/fluux/src/utils/downloadAttachment.test.ts
git commit -m "feat(attachments): add downloadAttachment helper that decrypts before saving"
```

---

### Task 2: `FileAttachmentCard` decrypts on download

**Files:**
- Modify: `apps/fluux/src/components/FileAttachments.tsx` (`FileAttachmentCard`, ~lines 490-529)
- Test: `apps/fluux/src/components/FileAttachments.test.tsx`

**Interfaces:**
- Consumes: `downloadAttachment` from `@/utils/download` (Task 1); `useState` from `react`; existing `Download`, `Loader2` icons; existing `useTranslation`.
- Produces: no new exports; behavioral change to `FileAttachmentCard`.

**Note on the test file's mock:** `FileAttachments.test.tsx` mocks `react-i18next` (t returns the key) and `@/hooks`. Task 2/3 additionally mock `@/utils/download` to assert the click calls `downloadAttachment`. Add this alongside the existing hoisted spies.

- [ ] **Step 1: Write the failing tests**

In `apps/fluux/src/components/FileAttachments.test.tsx`:

(a) Add to the hoisted block at the top (extend the existing `vi.hoisted`):

```ts
const { useAttachmentUrlSpy, useCachedMediaUrlSpy, downloadAttachmentSpy } = vi.hoisted(() => ({
  useAttachmentUrlSpy: vi.fn(),
  useCachedMediaUrlSpy: vi.fn(),
  downloadAttachmentSpy: vi.fn(),
}))
```

(b) Add a new mock next to the existing `vi.mock('@/hooks', …)`:

```ts
vi.mock('@/utils/download', () => ({
  downloadAttachment: downloadAttachmentSpy,
}))
```

(c) Import `FileAttachmentCard` — extend the existing import on line 3:

```ts
import { ImageAttachment, VideoAttachment, AudioAttachment, FileAttachmentCard } from './FileAttachments'
```

(d) Append this describe block at the end of the file:

```ts
describe('FileAttachmentCard download', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    downloadAttachmentSpy.mockResolvedValue(undefined)
  })

  const encryption = { cipher: 'aes-256-gcm' as const, key: new Uint8Array(32), iv: new Uint8Array(12) }

  it('plaintext file → renders a link to the raw URL (in-browser preview preserved)', () => {
    const pdf: FileAttachment = {
      url: 'https://x/doc.pdf', mediaType: 'application/pdf', name: 'doc.pdf',
    }
    render(<FileAttachmentCard attachment={pdf} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://x/doc.pdf')
    expect(downloadAttachmentSpy).not.toHaveBeenCalled()
  })

  it('encrypted file → clicking the card decrypts and downloads (no ciphertext link)', () => {
    const pdf: FileAttachment = {
      url: 'https://x/cipher.bin', mediaType: 'application/pdf', name: 'secret.pdf', encryption,
    }
    render(<FileAttachmentCard attachment={pdf} />)
    // Encrypted card is a button, not an anchor — never links to ciphertext.
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(downloadAttachmentSpy).toHaveBeenCalledTimes(1)
    expect(downloadAttachmentSpy.mock.calls[0][0]).toMatchObject({
      url: 'https://x/cipher.bin', name: 'secret.pdf', encryption,
    })
  })

  it('encrypted → works for a non-PDF type too (type-agnostic)', () => {
    const zip: FileAttachment = {
      url: 'https://x/cipher.bin', mediaType: 'application/zip', name: 'bundle.zip', encryption,
    }
    render(<FileAttachmentCard attachment={zip} />)
    fireEvent.click(screen.getByRole('button'))
    expect(downloadAttachmentSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx -t "FileAttachmentCard download"`
Expected: FAIL — encrypted case still renders an anchor / `downloadAttachment` not called.

- [ ] **Step 3: Make `FileAttachmentCard` decrypt-aware**

In `apps/fluux/src/components/FileAttachments.tsx`:

Add `useState` to the React import at the top (line 1 currently `import { useState, memo } from 'react'` — already present, keep it). Add `downloadAttachment` import near the other `@/utils` imports:

```ts
import { downloadAttachment } from '@/utils/download'
```

Replace the whole `FileAttachmentCard` function (currently ~lines 490-529) with:

```tsx
export function FileAttachmentCard({ attachment }: AttachmentProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const isEncrypted = Boolean(attachment.encryption)

  const iconWrap = (
    <div className={`size-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
      isPdfMimeType(attachment.mediaType) ? 'bg-red-500/20 text-red-500' :
      isEbookMimeType(attachment.mediaType) ? 'bg-purple-500/20 text-purple-500' :
      isDocumentMimeType(attachment.mediaType) ? 'bg-blue-500/20 text-blue-500' :
      isArchiveMimeType(attachment.mediaType) ? 'bg-yellow-500/20 text-yellow-500' :
      'bg-fluux-muted/20 text-fluux-muted'
    }`}>
      {isPdfMimeType(attachment.mediaType) ? <FileText className="size-5" /> :
       isEbookMimeType(attachment.mediaType) ? <BookOpen className="size-5" /> :
       isDocumentMimeType(attachment.mediaType) ? <FileText className="size-5" /> :
       isArchiveMimeType(attachment.mediaType) ? <Archive className="size-5" /> :
       <File className="size-5" />}
    </div>
  )

  const info = (
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium text-fluux-text truncate">
        {attachment.name || t('chat.file')}
      </p>
      <p className="text-xs text-fluux-muted">
        {getFileTypeLabel(attachment.mediaType)}
        {attachment.size && ` • ${formatBytes(attachment.size)}`}
      </p>
    </div>
  )

  const cardClass =
    'flex items-center gap-3 p-3 mt-2 max-w-sm rounded-lg bg-fluux-bg/60 border border-fluux-border hover:bg-fluux-hover/60 transition-colors group/file'

  // Encrypted: the URL points at ciphertext, so a plain link would save
  // unusable bytes. Decrypt on click and save the plaintext instead.
  if (isEncrypted) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await downloadAttachment(attachment, { errorMessage: t('common.downloadFailed') })
          } finally {
            setBusy(false)
          }
        }}
        className={`${cardClass} w-full text-start disabled:opacity-70`}
        aria-label={t('common.download')}
        tabIndex={-1}
      >
        {iconWrap}
        {info}
        {busy
          ? <Loader2 className="size-4 text-fluux-muted animate-spin flex-shrink-0" />
          : <Download className="size-4 text-fluux-muted opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0" />}
      </button>
    )
  }

  // Plaintext: keep the anchor so in-browser preview (target=_blank) still works.
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cardClass}
      tabIndex={-1}
    >
      {iconWrap}
      {info}
      <Download className="size-4 text-fluux-muted opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0" />
    </a>
  )
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx -t "FileAttachmentCard download"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole FileAttachments suite (no regressions)**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx`
Expected: PASS (all existing + new).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck -w @xmpp/fluux`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/FileAttachments.tsx apps/fluux/src/components/FileAttachments.test.tsx
git commit -m "fix(attachments): decrypt encrypted file downloads (PDF, docs, archives, any type)"
```

---

### Task 3: Media download controls + image error fallback decrypt

**Files:**
- Create: `apps/fluux/src/components/AttachmentDownloadButton.tsx`
- Modify: `apps/fluux/src/components/FileAttachments.tsx` (video info-bar + fallback, audio info-bar, video/audio/image error-fallback download controls)
- Test: `apps/fluux/src/components/FileAttachments.test.tsx`

**Interfaces:**
- Consumes: `downloadAttachment` from `@/utils/download` (Task 1); `Download`, `Loader2` from `lucide-react`; `useTranslation`; `FileAttachment` from `@fluux/sdk`.
- Produces:
  ```tsx
  export function AttachmentDownloadButton(props: {
    attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>
    className?: string
    iconClassName?: string
  }): JSX.Element
  ```
  Plaintext → `<a href={url} download={name}>` (unchanged behavior; existing `href` assertions keep passing). Encrypted → `<button>` calling `downloadAttachment`, showing a spinner while busy.

- [ ] **Step 1: Write the failing tests**

In `apps/fluux/src/components/FileAttachments.test.tsx`, append:

```ts
describe('encrypted media download controls', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    downloadAttachmentSpy.mockResolvedValue(undefined)
    useAttachmentUrlSpy.mockReturnValue({ url: 'blob:play', isLoading: false, error: null })
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  const encryption = { cipher: 'aes-256-gcm' as const, key: new Uint8Array(32), iv: new Uint8Array(12) }

  it('encrypted video info-bar download → button, decrypts (no ciphertext href)', () => {
    const video: FileAttachment = {
      url: 'https://x/cipher.bin', mediaType: 'video/mp4', name: 'clip.mp4', encryption,
    }
    render(<VideoAttachment attachment={video} />)
    const control = screen.getByLabelText('common.download')
    expect(control).not.toHaveAttribute('href')
    fireEvent.click(control)
    expect(downloadAttachmentSpy).toHaveBeenCalledTimes(1)
  })

  it('plaintext video info-bar download → still a link to the raw URL', () => {
    const video: FileAttachment = {
      url: 'https://x/clip.mp4', mediaType: 'video/mp4', name: 'clip.mp4',
    }
    render(<VideoAttachment attachment={video} />)
    expect(screen.getByLabelText('common.download')).toHaveAttribute('href', 'https://x/clip.mp4')
    expect(downloadAttachmentSpy).not.toHaveBeenCalled()
  })

  it('encrypted audio info-bar download → button, decrypts', () => {
    const audio: FileAttachment = {
      url: 'https://x/cipher.bin', mediaType: 'audio/mpeg', name: 'voice.mp3', encryption,
    }
    render(<AudioAttachment attachment={audio} />)
    fireEvent.click(screen.getByLabelText('common.download'))
    expect(downloadAttachmentSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx -t "encrypted media download controls"`
Expected: FAIL — encrypted media controls are still anchors to ciphertext; `downloadAttachment` not called.

- [ ] **Step 3: Create `AttachmentDownloadButton`**

Create `apps/fluux/src/components/AttachmentDownloadButton.tsx`:

```tsx
import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { downloadAttachment } from '@/utils/download'
import type { FileAttachment } from '@fluux/sdk'

interface Props {
  attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>
  /** Classes for the interactive element (anchor or button). */
  className?: string
  /** Classes for the icon glyph. */
  iconClassName?: string
}

/**
 * A download control that decrypts XEP-0454 (aesgcm) attachments before saving.
 *
 * Plaintext → a plain `<a href download>` so the browser/webview handles it
 * directly (and cross-client `file_share` URLs are preserved verbatim).
 * Encrypted → a `<button>` that resolves the decrypted bytes on click and
 * saves those; a spinner shows while decrypting. The ciphertext URL is never
 * exposed as an href.
 */
export function AttachmentDownloadButton({ attachment, className, iconClassName }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const icon = busy
    ? <Loader2 className={`${iconClassName ?? ''} animate-spin`} />
    : <Download className={iconClassName} />

  if (!attachment.encryption) {
    return (
      <a
        href={attachment.url}
        download={attachment.name || 'download'}
        className={className}
        aria-label={t('common.download')}
        tabIndex={-1}
      >
        {icon}
      </a>
    )
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await downloadAttachment(attachment, { errorMessage: t('common.downloadFailed') })
        } finally {
          setBusy(false)
        }
      }}
      className={className}
      aria-label={t('common.download')}
      tabIndex={-1}
    >
      {icon}
    </button>
  )
}
```

- [ ] **Step 4: Wire the media controls to it**

In `apps/fluux/src/components/FileAttachments.tsx`, add the import near the other component imports (below the `Tooltip` import, line ~4):

```ts
import { AttachmentDownloadButton } from './AttachmentDownloadButton'
```

Replace the **video info-bar** download control (the `<Tooltip>…<a href={attachment.url} download={attachment.name}>…</a></Tooltip>` block inside the success `return`, ~lines 368-378) with:

```tsx
          <Tooltip content={t('common.download')} position="top">
            <AttachmentDownloadButton
              attachment={attachment}
              className="p-1 rounded hover:bg-fluux-bg transition-colors flex-shrink-0"
              iconClassName="size-4 text-fluux-muted hover:text-fluux-text"
            />
          </Tooltip>
```

Replace the **video error-fallback** download control (the `<Tooltip>…<a href={attachment.url} download={attachment.name || 'video'}>…</a></Tooltip>` block, ~lines 318-328) with the same snippet (identical — `attachment` carries everything).

Replace the **audio info-bar** download control (the `<Tooltip>…<a href={attachment.url} download={attachment.name || 'audio'}>…</a></Tooltip>` block, ~lines 452-464) with the same snippet.

- [ ] **Step 5: Fix the image error-fallback whole-card link**

Still in `FileAttachments.tsx`, the `ImageAttachment` error state (~lines 142-168) wraps the whole card in `<a href={attachment.url}>`. For an encrypted image that failed to load, that links to ciphertext. Make it decrypt-aware by branching the wrapper: keep the anchor for plaintext, use a button that calls `downloadAttachment` for encrypted.

Replace the `if (error || !effectiveSrc || loadError) { return ( <a href={attachment.url} … > … </a> ) }` block with:

```tsx
  if (error || !effectiveSrc || loadError) {
    const inner = (
      <div
        className="flex flex-col items-center justify-center gap-2 px-3 rounded-lg bg-fluux-bg/60 border border-fluux-border hover:bg-fluux-hover/60 transition-colors text-fluux-muted"
        style={{ aspectRatio, maxHeight: '300px', minHeight: '100px' }}
      >
        <ImageOff className="size-6 flex-shrink-0" />
        <p className="text-sm font-medium truncate max-w-full">
          {attachment.name || t('chat.imageUnavailable')}
        </p>
        <p className="text-xs">
          {t('chat.imageUnavailable')}
          {attachment.size ? ` • ${formatBytes(attachment.size)}` : ''}
        </p>
        <Download className="size-4 opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0" />
      </div>
    )
    if (attachment.encryption) {
      return (
        <button
          type="button"
          onClick={() => void downloadAttachment(attachment, { errorMessage: t('common.downloadFailed') })}
          className="block pt-2 group/file w-full text-start"
          style={{ maxWidth: `${maxWidthPx}px` }}
          aria-label={t('common.download')}
          tabIndex={-1}
        >
          {inner}
        </button>
      )
    }
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block pt-2 group/file"
        style={{ maxWidth: `${maxWidthPx}px` }}
        tabIndex={-1}
      >
        {inner}
      </a>
    )
  }
```

Add the `downloadAttachment` import if not already present from Task 2 (it is, since both edit the same file):

```ts
import { downloadAttachment } from '@/utils/download'
```

- [ ] **Step 6: Run the new media tests**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx -t "encrypted media download controls"`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full FileAttachments suite (existing href assertions must still pass)**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx`
Expected: PASS — including the existing `should show unavailable message when proxy fetch fails` and `should preserve Prosody-style file_share URL in fallback download link` (both plaintext → still anchors with `href`).

- [ ] **Step 8: Typecheck + lint**

Run: `npm run typecheck -w @xmpp/fluux && npm run lint -w @xmpp/fluux`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/components/AttachmentDownloadButton.tsx apps/fluux/src/components/FileAttachments.tsx apps/fluux/src/components/FileAttachments.test.tsx
git commit -m "fix(attachments): decrypt encrypted media downloads and image error-fallback"
```

---

## Final verification

- [ ] **Full app test run**

Run: `npm run test:run -w @xmpp/fluux`
Expected: PASS, no stderr.

- [ ] **Typecheck + lint (whole repo)**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Manual verification (real app, encrypted PDF from edaveine)**

The demo/preview cannot exercise a real OX-encrypted attachment, so verify in the running app against the reported message:
1. Build + run: `npm run tauri:dev` (or `npm run dev` for web).
2. Open the conversation with `edaveine@process-one.net`, unlock OpenPGP.
3. On the encrypted PDF, click download → the saved file opens as a valid PDF (not ciphertext/garbage).
4. Repeat for a non-PDF encrypted attachment (e.g. an image or zip) to confirm type-agnostic behavior.
5. Confirm a plaintext attachment still downloads/opens exactly as before.

## Self-Review notes

- **Spec coverage:** file card (Task 2) + video/audio info-bar + video/audio/image error fallbacks (Task 3) = the three broken paths in the spec. `ImageLightbox` was already correct and is untouched. Type-agnostic detection (`attachment.encryption`) honored throughout.
- **No eager decrypt:** file card and media controls only call `downloadAttachment` inside `onClick`; render does nothing crypto-related.
- **Type consistency:** `downloadAttachment(attachment, { errorMessage })` signature is identical across Tasks 1–3; `AttachmentDownloadButton` prop names (`attachment`, `className`, `iconClassName`) are stable.
- **Existing tests preserved:** plaintext media controls remain `<a href>` so the `href`-asserting tests (including the Prosody `file_share` URL test) keep passing.
