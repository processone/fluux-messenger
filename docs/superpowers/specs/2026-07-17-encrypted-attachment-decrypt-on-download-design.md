# Decrypt encrypted attachments on download

**Date:** 2026-07-17
**Status:** Design — pending review
**Scope:** `apps/fluux` only. No SDK change, no new cryptography.

## Problem

When a peer sends an end-to-end-encrypted file (XEP-0454 media sharing inside a
XEP-0373 "OX" `urn:xmpp:openpgp:0` envelope), Fluux decrypts the message
envelope correctly and the SDK parses the `aesgcm://` reference into a
`FileAttachment`:

- `attachment.url` — a plain HTTPS URL pointing at **AES-GCM ciphertext**
- `attachment.encryption` — `{ cipher: 'aes-256-gcm', key, iv }`

Inline media (image / video / audio) resolves through `useAttachmentUrl`, which
fetches the ciphertext and calls `decryptFile` before rendering — so display
works. But every **download-to-disk** path ignores `attachment.encryption` and
links directly at `attachment.url`, i.e. at ciphertext. Downloading an encrypted
PDF, document, or archive therefore saves undecryptable bytes.

Observed live: a PDF from `edaveine@process-one.net` (Fluux desktop) — the OX
message decrypts, but the file card's download link yields ciphertext.

### The three broken paths

All in `apps/fluux/src/components/`:

1. **`FileAttachments.tsx` → `FileAttachmentCard`** (PDFs, documents, archives):
   `<a href={attachment.url} target="_blank">`. *Primary bug.*
2. **`FileAttachments.tsx` → video and audio** info-bar + error-fallback download
   links: `<a href={attachment.url} download>`.
3. **`FileAttachments.tsx` → image error-fallback** link: `<a href={attachment.url}>`.

`ImageLightbox.tsx`'s download button is already correct — it saves the
already-decrypted blob (`proxiedSrc`). It is the model this design generalizes.

## Non-goals

- **No inline preview** of encrypted non-media files. This change decrypts and
  saves to disk only. Inline PDF preview is a separate future feature.
- **No new crypto / no SDK change.** The file is AES-GCM (XEP-0454); the key/IV
  are already parsed into `attachment.encryption`. Detection is simply
  "`attachment.encryption` is present" — the explicit on-the-wire signal, no
  MIME/filename heuristics.
- **No eager decryption.** Encrypted file cards must not fetch+decrypt on render
  (large files, media-autoload deferral). Decryption happens on click.

## Design

### 1. Shared helper: `downloadAttachment`

Add to `apps/fluux/src/utils/download.ts`:

```
export async function downloadAttachment(
  attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>,
  options?: { errorMessage?: string },
): Promise<void>
```

Behavior:

- **No `attachment.encryption`** → delegate to the existing
  `downloadFile(attachment.url, name, options)`. Unchanged behavior.
- **Has `attachment.encryption`** → resolve the *decrypted* content URL using the
  same cached resolver the inline renderers use:
  - Tauri: `resolveEncryptedMediaUrl(url, encryption)` → `asset://…/{sha256}.dec`
  - Web: `resolveWebEncryptedMediaUrl(url, encryption)` → `blob:` URL
  Then call `downloadFile(decryptedUrl, name, options)`.

Reuse points:
- The resolvers already dedupe in-flight requests and cache decrypted output, so
  a file previously viewed inline downloads instantly (cache hit), and a
  download-then-view is a hit too.
- `downloadFile` already handles the platform save mechanics (native save dialog
  + `writeFile` on Tauri via `fetch(assetUrl)`; `<a download>` on web with a
  same-origin blob URL, so the filename is honored) and already surfaces a
  localized error toast on failure.
- A decrypt/fetch failure inside the resolver (AEAD auth-tag mismatch, 404, etc.)
  propagates; `downloadAttachment` catches it and emits the same error toast as
  `downloadFile`, so tampered/broken ciphertext never silently writes a file.

`name` falls back to a sensible default (`attachment.name ?? 'download'`).

### 2. `FileAttachmentCard` — decrypt-aware

- **Plaintext (`!encryption`)**: keep the current `<a href target="_blank">` so
  in-browser preview of plain PDFs still works. No change.
- **Encrypted**: render a `<button>` that calls `downloadAttachment(attachment)`
  with a small in-progress state (spinner on the download glyph, disabled while
  resolving) so a multi-megabyte decrypt gives feedback. On success the file is
  saved; on failure the shared error toast fires.

The card keeps its existing visual layout (icon, name, type/size, download
glyph); only the click target and its element type differ by branch.

### 3. Video / audio / image download buttons

Replace the ciphertext `<a href={attachment.url} …>` download controls in the
video info-bar, audio info-bar, and the video/audio/image error-fallback states
with a control that calls `downloadAttachment(attachment, { errorMessage })`.
For the success info-bar states the decrypted bytes are already cached from
playback, so the download is instant; for error states the helper still attempts
a fresh fetch+decrypt and toasts on failure.

## Data flow (encrypted download)

```
click download
  → downloadAttachment(attachment)
    → resolve*EncryptedMediaUrl(attachment.url, attachment.encryption)   // cached
        → (miss) fetch ciphertext → decryptFile(bytes, key, iv)          // AEAD-verified
        → write plaintext to platform cache → return asset://|blob: URL
    → downloadFile(decryptedUrl, attachment.name)
        → Tauri: save dialog → fetch(decryptedUrl) → writeFile
        → Web:  <a download="name" href="blob:…">
```

## Testing

- **Unit (`download.test.ts`)**: extend to cover `downloadAttachment`.
  - No-encryption → calls `downloadFile` with the raw URL (delegation).
  - With-encryption → resolves via the (mocked) encrypted resolver, then calls
    `downloadFile` with the decrypted URL, never the ciphertext URL.
  - Resolver rejection → error toast, no `writeFile`/anchor with ciphertext.
  - Platform branch (Tauri vs web) picks the matching resolver.
- **Component**: `FileAttachmentCard` renders a plain `<a>` for a plaintext
  attachment and a decrypt button for an encrypted one; clicking the button
  invokes `downloadAttachment`.
- Existing `messageStyles.aesgcm.test.tsx` / `mediaCache.test.ts` continue to
  pass (resolvers untouched).

## Files touched

- `apps/fluux/src/utils/download.ts` — add `downloadAttachment`.
- `apps/fluux/src/utils/download.test.ts` — add coverage.
- `apps/fluux/src/components/FileAttachments.tsx` — file card + media download
  controls become decrypt-aware.
- Possibly `apps/fluux/src/components/ImageLightbox.tsx` — only if consolidating
  its already-correct download onto the shared helper (optional, cosmetic).

No new i18n keys required beyond the existing `common.downloadFailed` /
`common.download`.
