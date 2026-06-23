# Own-Message Media Autoload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the local user's own sent media (images, video, audio, text-file previews, link-preview images) inline automatically, even where the media-autoload policy would otherwise defer it to a "tap to load" placeholder (notably public rooms and 1:1 stranger chats).

**Architecture:** Layer a per-message override on top of the existing per-conversation media-autoload gate. The single gate `useDeferredMedia(url)` gains an `isOwnMessage` flag that short-circuits the deferral. `message.isOutgoing` is threaded from `MessageBubble` down through the attachment/preview renderers to the gate. No SDK change.

**Tech Stack:** React, TypeScript, Zustand, Vitest, @testing-library/react.

## Global Constraints

- App-only change. Do not modify `packages/fluux-sdk`. `message.isOutgoing` already exists on the message type.
- Own content always loads under all policies, including "Never". The autoload policy governs only other people's remote media.
- No new user setting, no change to `computeMediaAutoload` or `ConversationTrust`.
- No em-dashes or en-dashes in any user-facing text (this change adds none, but the rule stands).
- Pre-commit gate (from CLAUDE.md): unit tests pass with no errors or stderr, `npm run typecheck` passes, `npm run lint` passes.
- Work happens on branch `feat/own-message-media-autoload` (already created). Squash-merge to main via PR.

---

### Task 1: Add `isOwnMessage` to the `useDeferredMedia` gate

**Files:**
- Modify: `apps/fluux/src/hooks/useDeferredMedia.ts`
- Test: `apps/fluux/src/hooks/useDeferredMedia.test.tsx` (create)

**Interfaces:**
- Consumes: `useMediaAutoload()` (boolean context), `isMediaUrlApproved`, `approveMediaUrl`, `__resetApprovedMediaUrlsForTest` from `@/utils/mediaAutoload`; `MediaAutoloadProvider` from `@/contexts`.
- Produces: `useDeferredMedia(sourceUrl: string, isOwnMessage?: boolean): { shouldLoad: boolean; approve: () => void }`. `isOwnMessage` defaults to `false`. When `true`, `shouldLoad` is forced `true`. Task 2 relies on this two-arg signature.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/useDeferredMedia.test.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MediaAutoloadProvider } from '@/contexts'
import { useDeferredMedia } from './useDeferredMedia'
import { __resetApprovedMediaUrlsForTest } from '@/utils/mediaAutoload'

function Probe({ url, isOwnMessage }: { url: string; isOwnMessage?: boolean }) {
  const { shouldLoad } = useDeferredMedia(url, isOwnMessage)
  return <span>{shouldLoad ? 'load' : 'defer'}</span>
}

describe('useDeferredMedia', () => {
  beforeEach(() => __resetApprovedMediaUrlsForTest())

  it('defers when the context auto-load is false and the message is not own', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <Probe url="https://x/a.jpg" />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('defer')).toBeInTheDocument()
  })

  it('loads own-message media even when the context auto-load is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <Probe url="https://x/b.jpg" isOwnMessage />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('load')).toBeInTheDocument()
  })

  it('still auto-loads non-own media when the context auto-load is true', () => {
    render(
      <MediaAutoloadProvider autoLoad>
        <Probe url="https://x/c.jpg" />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('load')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useDeferredMedia.test.tsx`
Expected: the second test ("loads own-message media...") FAILS. Before the change the hook ignores the second argument, so `shouldLoad` stays `false` and the probe renders `defer` instead of `load`. (The other two tests already pass.)

- [ ] **Step 3: Implement the minimal change**

Replace the body of `apps/fluux/src/hooks/useDeferredMedia.ts` with:

```ts
import { useState } from 'react'
import { useMediaAutoload } from '@/contexts'
import { approveMediaUrl, isMediaUrlApproved } from '@/utils/mediaAutoload'

/**
 * Gates a single remote-media fetch behind the conversation's media-autoload
 * policy. Returns whether the media should load now (the policy auto-loads, the
 * user already tapped this URL this session, or the message is the local user's
 * own) plus an `approve` callback to call when the user taps to load.
 *
 * `isOwnMessage` short-circuits the deferral: content the local user authored
 * carries no IP-leak or safety cost, so it always loads regardless of policy.
 */
export function useDeferredMedia(
  sourceUrl: string,
  isOwnMessage = false,
): { shouldLoad: boolean; approve: () => void } {
  const autoLoad = useMediaAutoload()
  const [approved, setApproved] = useState(() => isMediaUrlApproved(sourceUrl))
  const shouldLoad = autoLoad || approved || isOwnMessage
  const approve = () => {
    approveMediaUrl(sourceUrl)
    setApproved(true)
  }
  return { shouldLoad, approve }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useDeferredMedia.test.tsx`
Expected: all three tests PASS, no stderr.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: passes (no errors).

```bash
git add apps/fluux/src/hooks/useDeferredMedia.ts apps/fluux/src/hooks/useDeferredMedia.test.tsx
git commit -m "feat(media): add isOwnMessage bypass to useDeferredMedia gate"
```

---

### Task 2: Thread `isOwnMessage` from MessageBubble through every media renderer

**Files:**
- Modify: `apps/fluux/src/components/FileAttachments.tsx` (AttachmentProps + ImageAttachment:36,56 + VideoAttachment:228,236 + AudioAttachment:379,387)
- Modify: `apps/fluux/src/components/TextFilePreview.tsx` (props + 21,24)
- Modify: `apps/fluux/src/components/MessageAttachments.tsx` (props + 34,42,45,48,51)
- Modify: `apps/fluux/src/components/LinkPreviewCard.tsx` (props + 25,30)
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx:626,629`
- Test: `apps/fluux/src/components/FileAttachments.test.tsx` (extend), `apps/fluux/src/components/LinkPreviewCard.test.tsx` (extend)

**Interfaces:**
- Consumes: `useDeferredMedia(url, isOwnMessage)` from Task 1.
- Produces: optional `isOwnMessage?: boolean` prop on `AttachmentProps`, `MessageAttachmentsProps`, `TextFilePreviewProps`, `LinkPreviewCardProps`. `MessageBubble` passes `message.isOutgoing` to `<MessageAttachments>` and `<LinkPreviewCard>`.

- [ ] **Step 1: Write the failing wiring tests**

In `apps/fluux/src/components/FileAttachments.test.tsx`, add an import for `MessageAttachments` at the top (next to the existing `./FileAttachments` import):

```tsx
import { MessageAttachments } from './MessageAttachments'
```

Then append this describe block at the end of the file (it reuses the module-level `deferralImageAttachment` and the hoisted `@/hooks` mock already defined in this file):

```tsx
describe('MessageAttachments own-message threading', () => {
  beforeEach(() => {
    __resetApprovedMediaUrlsForTest()
    useAttachmentUrlSpy.mockImplementation((_u: string | undefined, _e: unknown, enabled: boolean) => ({
      url: enabled ? 'blob:loaded' : null,
      isLoading: false,
      error: null,
    }))
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  it('loads an own-message image inline even when autoLoad is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <MessageAttachments attachment={deferralImageAttachment} isOwnMessage />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.queryByText('chat.loadImage')).not.toBeInTheDocument()
  })

  it('defers a non-own image when autoLoad is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <MessageAttachments attachment={deferralImageAttachment} />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('chat.loadImage')).toBeInTheDocument()
  })
})
```

In `apps/fluux/src/components/LinkPreviewCard.test.tsx`, add this test inside the existing `describe('LinkPreviewCard image deferral', ...)` block (it uses that block's local `preview` const):

```tsx
  it('shows the OG image for an own-message preview even when autoLoad is false', () => {
    const { container } = render(
      <MediaAutoloadProvider autoLoad={false}>
        <LinkPreviewCard preview={preview} isOwnMessage />
      </MediaAutoloadProvider>,
    )
    expect(container.querySelector('img')).not.toBeNull()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx src/components/LinkPreviewCard.test.tsx`
Expected: the two new "own-message" tests FAIL. The `isOwnMessage` prop is not yet threaded, so the own image still shows the `chat.loadImage` placeholder (no `img`) and the own preview suppresses its image. The "defers a non-own image" test passes.

- [ ] **Step 3: Add `isOwnMessage` to `AttachmentProps` and the three FileAttachments renderers**

In `apps/fluux/src/components/FileAttachments.tsx`, extend `AttachmentProps` (currently lines 25-29):

```ts
interface AttachmentProps {
  attachment: FileAttachment
  /** Called when image/video loads - useful for scroll adjustment */
  onLoad?: () => void
  /** When true (the local user's own message), bypass media-autoload deferral. */
  isOwnMessage?: boolean
}
```

Update `ImageAttachment` signature (line 36) and its `useDeferredMedia` call (line 56):

```ts
export const ImageAttachment = memo(function ImageAttachment({ attachment, onLoad, isOwnMessage }: AttachmentProps) {
```

```ts
  const { shouldLoad, approve } = useDeferredMedia(originalImageSrc, isOwnMessage)
```

Update `VideoAttachment` signature (line 228) and its `useDeferredMedia` call (line 236):

```ts
export const VideoAttachment = memo(function VideoAttachment({ attachment, onLoad, isOwnMessage }: AttachmentProps) {
```

```ts
  const { shouldLoad, approve } = useDeferredMedia(attachment.url, isOwnMessage)
```

Update `AudioAttachment` signature (line 379) and its `useDeferredMedia` call (line 387):

```ts
export function AudioAttachment({ attachment, isOwnMessage }: AttachmentProps) {
```

```ts
  const { shouldLoad, approve } = useDeferredMedia(attachment.url, isOwnMessage)
```

- [ ] **Step 4: Add `isOwnMessage` to `TextFilePreview`**

In `apps/fluux/src/components/TextFilePreview.tsx`, extend `TextFilePreviewProps` (lines 9-15):

```ts
interface TextFilePreviewProps {
  attachment: FileAttachment
  /** Whether the parent message is selected (for gradient adaptation) */
  isSelected?: boolean
  /** Whether the parent message is hovered (for gradient adaptation) */
  isHovered?: boolean
  /** When true (the local user's own message), bypass media-autoload deferral. */
  isOwnMessage?: boolean
}
```

Update the signature (line 21) and the `useDeferredMedia` call (line 24):

```ts
export function TextFilePreview({ attachment, isSelected = false, isHovered = false, isOwnMessage }: TextFilePreviewProps) {
```

```ts
  const { shouldLoad, approve } = useDeferredMedia(attachment.url, isOwnMessage)
```

- [ ] **Step 5: Forward `isOwnMessage` through `MessageAttachments`**

In `apps/fluux/src/components/MessageAttachments.tsx`, extend `MessageAttachmentsProps` (lines 19-27) by adding:

```ts
  /** Whether the parent message is the local user's own (bypasses media-autoload deferral). */
  isOwnMessage?: boolean
```

Update the signature (line 34):

```ts
export function MessageAttachments({ attachment, onMediaLoad, isSelected, isHovered, isOwnMessage }: MessageAttachmentsProps) {
```

Pass `isOwnMessage` to the gated renderers (lines 42, 45, 48, 51). `FileAttachmentCard` (line 54) does not gate, so leave it unchanged:

```tsx
      {/* Image attachment preview */}
      <ImageAttachment attachment={attachment} onLoad={onMediaLoad} isOwnMessage={isOwnMessage} />

      {/* Video attachment with inline player */}
      <VideoAttachment attachment={attachment} onLoad={onMediaLoad} isOwnMessage={isOwnMessage} />

      {/* Audio attachment with inline player */}
      <AudioAttachment attachment={attachment} isOwnMessage={isOwnMessage} />

      {/* Text file preview (code, markdown, json, etc.) */}
      {canPreview && <TextFilePreview attachment={attachment} isSelected={isSelected} isHovered={isHovered} isOwnMessage={isOwnMessage} />}
```

- [ ] **Step 6: Add `isOwnMessage` to `LinkPreviewCard`**

In `apps/fluux/src/components/LinkPreviewCard.tsx`, extend `LinkPreviewCardProps` (lines 20-23):

```ts
interface LinkPreviewCardProps {
  preview: LinkPreview
  onLoad?: () => void
  /** When true (the local user's own message), bypass media-autoload deferral. */
  isOwnMessage?: boolean
}
```

Update the signature (line 25) and the `useDeferredMedia` call (line 30):

```ts
export function LinkPreviewCard({ preview, onLoad, isOwnMessage }: LinkPreviewCardProps) {
```

```ts
  const { shouldLoad: showImage, approve: approveImage } = useDeferredMedia(preview.image ?? '', isOwnMessage)
```

- [ ] **Step 7: Pass `message.isOutgoing` from `MessageBubble`**

In `apps/fluux/src/components/conversation/MessageBubble.tsx`, update line 626:

```tsx
          {!message.isRetracted && <MessageAttachments attachment={message.attachment} onMediaLoad={onMediaLoad} isSelected={isSelected} isHovered={isHovered} isOwnMessage={message.isOutgoing} />}
```

And line 629:

```tsx
          {!message.isRetracted && message.linkPreview && <LinkPreviewCard preview={message.linkPreview} onLoad={onMediaLoad} isOwnMessage={message.isOutgoing} />}
```

- [ ] **Step 8: Run the wiring tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/FileAttachments.test.tsx src/components/LinkPreviewCard.test.tsx`
Expected: all tests PASS, no stderr. The own-message image now renders inline and the own-message preview image shows.

- [ ] **Step 9: Run the full pre-commit gate**

Run: `npm test`
Expected: all workspace tests pass, no errors or stderr.

Run: `npm run typecheck`
Expected: passes.

Run: `npm run lint`
Expected: passes.

- [ ] **Step 10: Commit**

```bash
git add apps/fluux/src/components/FileAttachments.tsx apps/fluux/src/components/TextFilePreview.tsx apps/fluux/src/components/MessageAttachments.tsx apps/fluux/src/components/LinkPreviewCard.tsx apps/fluux/src/components/conversation/MessageBubble.tsx apps/fluux/src/components/FileAttachments.test.tsx apps/fluux/src/components/LinkPreviewCard.test.tsx
git commit -m "feat(media): auto-load own-message media in public rooms"
```

---

### Task 3: Verify in the running app

**Files:** none (manual/preview verification).

This confirms the full thread end to end, which the unit tests cannot (MessageBubble passing `message.isOutgoing` is exercised here).

- [ ] **Step 1: Start the dev server and open demo mode**

Run the app (preview tooling or `npm run dev`) and open `http://localhost:5173/demo.html`. Ensure the media-autoload policy is the default `private-only` (Settings > media auto-download), so public-room media defers.

- [ ] **Step 2: Confirm the behavior in a public room**

Open a public (non members-only) room. Confirm:
- An image you sent renders inline (no "tap to load" placeholder).
- A link you posted shows its preview image inline.
- Another participant's image/link still shows the "tap to load" placeholder (unchanged behavior).

If the demo seed has no own image/link in a public room, send one (or verify against a real account joined to a public room). Capture a screenshot of an own image rendered inline next to a peer's deferred placeholder as proof.

- [ ] **Step 3: Spot-check "Never" policy**

Set media auto-download to "Never". Confirm your own sent image/link still renders inline, while other people's media defers. This validates the "own content always loads, under all policies" decision.

---

## Self-Review

**Spec coverage:**
- "Own sent media renders inline automatically, wherever it would otherwise defer" -> Task 1 (gate) + Task 2 (threading).
- "Covers image, video, audio, text-file preview, link-preview image" -> Task 2 Steps 3-6 touch all five gated renderers.
- "App-only, no SDK change" -> all files under `apps/fluux`.
- "Other people's media unchanged" -> `isOwnMessage` defaults to `false`; non-own tests in Task 1 and Task 2 assert deferral is preserved.
- "Under all policies including Never" -> `shouldLoad = autoLoad || approved || isOwnMessage` is policy-independent; Task 3 Step 3 verifies.
- "Add useDeferredMedia.test.tsx; optionally extend FileAttachments.test.tsx" -> Task 1 creates the hook test; Task 2 extends FileAttachments.test.tsx (MessageAttachments wiring) and LinkPreviewCard.test.tsx.

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step shows complete code.

**Type consistency:** `useDeferredMedia(sourceUrl, isOwnMessage?)` defined in Task 1 is used with two args throughout Task 2. `isOwnMessage?: boolean` is the identical optional-prop name on `AttachmentProps`, `MessageAttachmentsProps`, `TextFilePreviewProps`, `LinkPreviewCardProps`. `MessageBubble` passes `message.isOutgoing` (existing `BaseMessage` field).
