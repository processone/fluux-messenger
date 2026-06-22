# Own-Message Media Autoload - Design

**Date:** 2026-06-22
**Status:** Approved design, ready for implementation plan

## Problem

The app gates remote-media fetches (images, video, audio, text-file previews,
link-preview images) behind a privacy policy. The default policy is
`private-only` (settingsStore.ts:68), which in a public room computes
`mediaAutoLoad = false` (RoomView.tsx:444). Every remote item then defers to a
"tap to load" placeholder (FileAttachments.tsx:107).

That deferral makes no distinction for the local user's own messages. The
concrete result:

- Post an image in a public room and you see "tap to load" on the image you
  just sent.
- Share a link and its preview image defers too (the og:image is third-party,
  so it is never in cache and stays a placeholder).

The deferral exists for a real reason: auto-loading a stranger's remote URL
leaks your IP and signals engagement to a URL chosen by someone else. But that
threat model does not apply to content the local user authored. There is no
privacy or safety cost to loading media you sent yourself.

`message.isOutgoing` already cleanly identifies the local user's own messages,
including sent-carbons (copies of messages you sent from another device).

## Goals

- The local user's own sent media renders inline automatically, without a
  "tap to load" step, wherever it would otherwise defer.
- Covers every gated media type: image, video, audio, text-file preview, and
  link-preview image.
- App-only change. No SDK change (the `isOutgoing` flag already exists on the
  message).
- No behavior change for other people's media: it still follows the autoload
  policy exactly as today.

## Non-Goals

- No change to `computeMediaAutoload` or the `ConversationTrust` model.
- No new user setting. This is unconditional behavior derived from message
  authorship.
- No change to the session approved-URL mechanism or the cache-peek path.

## Decisions (from brainstorming)

- **Own content always loads, under all policies including "Never."** The
  autoload policy governs only other people's remote media. There is no privacy
  or safety reason to hide content you authored, and a "tap to load" on an image
  you just sent is poor UX. (User decision.)
- **Universal scope.** The exemption applies anywhere your own media could
  otherwise defer: public rooms and 1:1 stranger chats alike. It naturally has
  no effect where media already auto-loads.
- **Per-message seam.** Conversation trust is per-conversation, but
  own-vs-other is per-message, so the exemption is layered in the per-message
  gate (`useDeferredMedia`), not in `computeMediaAutoload`.

## Approach

Chosen: thread a per-message `isOwnMessage` flag into the existing
`useDeferredMedia` gate and OR it into the load decision.

Rejected alternatives:

- **Per-message `MediaAutoloadProvider` wrapper** (`autoLoad={true}` around own
  bubbles): a context provider per message bubble is heavier and muddies the
  context's per-conversation meaning.
- **Auto-approve own URLs via `approveMediaUrl()`**: side-effecting the shared
  session approved-set during render is wrong and order-dependent.

## Design

### 1. Gate

`useDeferredMedia` gains a second parameter, defaulting to `false` so existing
callers are unaffected:

```ts
export function useDeferredMedia(
  sourceUrl: string,
  isOwnMessage = false,
): { shouldLoad: boolean; approve: () => void } {
  const autoLoad = useMediaAutoload()
  const [approved, setApproved] = useState(() => isMediaUrlApproved(sourceUrl))
  const shouldLoad = autoLoad || approved || isOwnMessage
  // ...unchanged
}
```

### 2. Threading `isOwnMessage = message.isOutgoing`

- **MessageBubble.tsx**: pass `isOwnMessage={message.isOutgoing}` to
  `<MessageAttachments>` (MessageBubble.tsx:626) and `<LinkPreviewCard>`
  (MessageBubble.tsx:629).
- **MessageAttachments.tsx**: add `isOwnMessage?: boolean` to
  `MessageAttachmentsProps`; forward it to the gated renderers
  (`ImageAttachment`, `VideoAttachment`, `AudioAttachment`, and the text-file
  preview). `FileAttachmentCard` does not gate, so it needs no change.
- **FileAttachments.tsx**: add `isOwnMessage?: boolean` to `AttachmentProps`;
  in `ImageAttachment`, `VideoAttachment`, `AudioAttachment`, pass it as the
  second arg to `useDeferredMedia` (FileAttachments.tsx:56,236,387).
- **TextFilePreview.tsx**: accept `isOwnMessage?: boolean` and pass it to
  `useDeferredMedia` (TextFilePreview.tsx:24).
- **LinkPreviewCard.tsx**: add `isOwnMessage?: boolean` and pass it to
  `useDeferredMedia` (LinkPreviewCard.tsx:30).

### 3. Unchanged

- `computeMediaAutoload` and `ConversationTrust` are untouched.
- The cache-peek path (`useCachedMediaUrl`) and session approved-set are
  untouched. For own messages `shouldLoad` is now `true`, so the normal fetch
  path runs and the cache-peek branch is simply skipped.

## Testing

The hook has no dedicated test today. Existing coverage lives in
`mediaAutoload.test.ts` (the pure `computeMediaAutoload`),
`MediaAutoloadContext.test.tsx`, `FileAttachments.test.tsx`, and
`LinkPreviewCard.test.tsx`.

- Add `apps/fluux/src/hooks/useDeferredMedia.test.tsx`: with `renderHook`
  wrapped in `MediaAutoloadProvider autoLoad={false}`, assert
  `isOwnMessage = true` yields `shouldLoad === true`, and `isOwnMessage = false`
  (and the omitted default) still yields `shouldLoad === false`.
- Optionally extend `FileAttachments.test.tsx` to assert an own-message image
  renders inline (no deferred placeholder) when the context defers.

## Files touched

- `apps/fluux/src/hooks/useDeferredMedia.ts`
- `apps/fluux/src/components/conversation/MessageBubble.tsx`
- `apps/fluux/src/components/MessageAttachments.tsx`
- `apps/fluux/src/components/FileAttachments.tsx`
- `apps/fluux/src/components/TextFilePreview.tsx`
- `apps/fluux/src/components/LinkPreviewCard.tsx`
- `apps/fluux/src/hooks/useDeferredMedia.test.tsx` (new)
