# Don't auto-download media in public channels — design

- **Date**: 2026-06-16
- **Issue**: [#36 — Public channels: don't autodownload files](https://github.com/processone/fluux-messenger/issues/36)
- **Status**: Approved, ready for implementation plan
- **Scope**: App-only (`apps/fluux`). No SDK change — the prerequisite store fix landed in #563.

## Problem

In a public XMPP channel (anyone can join and post), several message renderers fetch a
remote URL the moment a message paints on screen. Today these fetches are unconditional:

- `ImageAttachment`, `VideoAttachment`, `AudioAttachment` — fetch+cache via `useAttachmentUrl(..., enabled=isMedia)`.
- `TextFilePreview` — fetches the first ~1 KB of the file via `useTextPreview(url, enabled)`.
- `LinkPreviewCard` — renders `<img src={preview.image}>` directly (raw remote URL, no proxy).

For a public channel this is a privacy and safety problem: a hostile poster's URL learns the
viewer's IP, approximate read time, and user-agent simply because the message scrolled into
view. Non-media files (`FileAttachmentCard`: PDFs, docs, archives) are already click-to-open
`<a href>` links, so they are unaffected.

The goal: give the user control over when media loads automatically; default to a safe policy
where **public channels never auto-fetch** (the user taps each item to load it); and treat
**direct messages from strangers** (senders not in the roster) as a stricter,
non-configurable floor that never auto-fetches regardless of the policy.

## Behaviour model

A single global preference `mediaAutoDownload` with three values, default `'private-only'`,
combined with a per-conversation *trust* level:

| Policy           | 1:1 contact | 1:1 stranger | Private room (`isPrivate`) | Public / open room (`!isPrivate`) |
| ---------------- | ----------- | ------------ | -------------------------- | --------------------------------- |
| `always`         | load        | **defer †**  | load                       | load                              |
| `private-only` * | load        | **defer †**  | load                       | **defer**                         |
| `never`          | defer       | defer        | defer                      | defer                             |

\* default  †  **hard floor — see below**

The policy is a personal client preference (like theme/time-format), stored in the app's
`settingsStore` with `localStorage` persistence. It is **not** an XMPP/account setting.

### Trust levels (fail-safe)

Each conversation maps to one `ConversationTrust`:

- **`direct-stranger`** — a 1:1 conversation whose peer bare JID is **not in the roster**.
  Media from strangers **never** auto-loads, *regardless of policy* — `always` does not relax
  it. A direct message from an unknown JID is a stronger sign of targeting than a poster in a
  room the user chose to join, so it is the strictest tier. (The user can still tap to load
  any individual item; the floor blocks only *automatic* fetching.) This reuses the SDK's
  existing stranger definition — `roster.hasContact(jid)` at `core/modules/Chat.ts:1988`,
  which already routes first messages from non-contacts to the "stranger messages" events
  area. In React, read it via the existing `useContactIdentities()` map that ChatView already
  holds (`contactsByJid.has(peerJid)`); that map is built from the roster `contacts` map
  (`hooks/useContactIdentities.ts`), so `.has` is exactly `roster.hasContact`. When the user
  accepts/adds the contact the map gains the JID, trust flips to `direct-contact`, and policy
  applies. (If the roster has not finished loading, a contact briefly reads as a stranger and
  media defers until it syncs — the safe direction.)
- **`direct-contact`** — 1:1 with a roster contact. Treated as private; subject to policy.
- **`room-private`** — members-only (`muc_membersonly`) or hidden (`muc_hidden`) room
  (`core/roomCapabilities.ts:isPrivateRoom`). Treated as private; subject to policy.
- **`room-public`** — any other (open) room. Subject to policy; deferred under
  `private-only`/`never`, loaded under `always`.
  - A room whose disco has not resolved (or failed) has `isPrivate` falsy → treated as
    `room-public` → deferred under the default. Deliberate fail-safe (same philosophy as
    issue #37): when unsure, protect the user. When disco resolves to private, the context
    value flips and media auto-loads.

We intentionally key rooms off `isPrivate`, **not** `isNonAnonymous`: a large anonymous public
channel still lets hostile strangers post URLs, so anonymity is irrelevant to this threat.
`room.isPrivate` is reliable on the active room entity as of #563, read via
`useRoomActive().activeRoom`.

## Architecture

### Pure policy helper

`apps/fluux/src/utils/mediaAutoload.ts`

```ts
export type ConversationTrust =
  | 'direct-contact'   // 1:1 with a roster contact
  | 'direct-stranger'  // 1:1 with a non-contact: media NEVER auto-loads
  | 'room-private'     // members-only / hidden room
  | 'room-public'      // open / public room

export function computeMediaAutoload(
  policy: MediaAutoDownload,
  trust: ConversationTrust,
): boolean {
  // Hard floor: strangers never auto-load, even under 'always'.
  if (trust === 'direct-stranger') return false
  if (policy === 'always') return true
  if (policy === 'never') return false
  // 'private-only': load everywhere except public rooms.
  return trust !== 'room-public'
}

// Session-only set of URLs the user explicitly tapped to load. Mirrors the
// existing module-level `failedUrlCache` in FileAttachments — survives bubble
// unmount/remount during scroll, but not an app restart.
const sessionApprovedUrls = new Set<string>()
export function approveMediaUrl(url: string): void { sessionApprovedUrls.add(url) }
export function isMediaUrlApproved(url: string): boolean { return sessionApprovedUrls.has(url) }
```

### Context

`apps/fluux/src/contexts/MediaAutoloadContext.tsx`

- `MediaAutoloadProvider` provides a single `boolean` (`autoLoad`).
- `useMediaAutoload(): boolean` — **defaults to `true`** when there is no provider, so any
  consumer rendered outside a provider (e.g. `SearchContextView`, unit tests) keeps today's
  auto-loading behaviour. The privacy policy only applies where a provider wraps the subtree.

Both conversation views compute a `ConversationTrust`, then the boolean, and wrap their
message list:

- `RoomView`: `trust = activeRoom?.isPrivate ? 'room-private' : 'room-public'`
- `ChatView`: `trust = contactsByJid.has(activeConversation.id) ? 'direct-contact' :
  'direct-stranger'`, where `contactsByJid` is the existing `useContactIdentities()` map and
  `activeConversation.id` is the peer bare JID. No new import or SDK export.
- both: `autoLoad = computeMediaAutoload(policy, trust)`

`policy` is read with `useSettingsStore((s) => s.mediaAutoDownload)`. The provider value
changes only when the policy changes (rare), a room's `isPrivate` resolves (once), or the peer
is added to the roster (flips `direct-stranger` → `direct-contact`) — so it does not add
render churn to the message list.

### Per-leaf gating

Each fetch surface is a leaf that already has an `enabled`/conditional-render gate. The
pattern is identical across all of them:

```ts
const autoLoad = useMediaAutoload()
const [loaded, setLoaded] = useState(() => isMediaUrlApproved(sourceUrl))
const shouldLoad = autoLoad || loaded
const handleLoad = () => { approveMediaUrl(sourceUrl); setLoaded(true) }
// gate the fetch:           useAttachmentUrl(url, enc, isMedia && shouldLoad)
// when !shouldLoad:         render a DeferredMediaPlaceholder with onLoad={handleLoad}
```

`sourceUrl` (the session-approval key) per surface:

| Surface             | Fetch hook / element                        | `sourceUrl` key                          |
| ------------------- | ------------------------------------------- | ---------------------------------------- |
| `ImageAttachment`   | `useAttachmentUrl(originalImageSrc, …)`     | `attachment.thumbnail?.uri ?? attachment.url` |
| `VideoAttachment`   | `useAttachmentUrl(attachment.url, …)`       | `attachment.url`                         |
| `AudioAttachment`   | `useAttachmentUrl(attachment.url, …)`       | `attachment.url`                         |
| `TextFilePreview`   | `useTextPreview(url, enabled)`              | `attachment.url`                         |
| `LinkPreviewCard`   | `<img src={preview.image}>`                 | `preview.image`                          |

### Deferred placeholder

`apps/fluux/src/components/DeferredMediaPlaceholder.tsx` — one reusable, tappable component
with two layouts:

- `variant="box"` (image, video): reserves the same aspect-ratio box the loaded media would
  use (`aspectRatio`, `maxWidthPx` props, reusing each renderer's existing dimension logic),
  centered type icon + label (e.g. "Load image") + size. Reserving the box avoids the layout
  shift that feeds the WebKitGTK message-list ResizeObserver scroll-correction loop.
- `variant="card"` (audio, text file): a compact horizontal row (icon + filename + size +
  "Tap to load"), matching the `FileAttachmentCard` look.

The whole placeholder is a `<button>` (or `role="button"` + keyboard handler) calling
`onLoad`. After a tap, the normal flow runs (loading spinner → media), and the URL is in
`sessionApprovedUrls` so scrolling away and back keeps it loaded.

### Link preview specifics

`LinkPreviewCard` is wrapped in a single `<a href>`. The textual metadata (title, description,
domain, site name) arrives inline with the message and always renders — only the
`<img src={preview.image}>` is gated. When deferred, render the image area as a tappable
placeholder strip (a `div role="button"` to avoid an invalid nested `<button>` inside the
anchor) whose handler calls `e.preventDefault(); e.stopPropagation();` then loads the image.
Label: "Show image". Aspect ratio: the existing `aspect-video` box.

## Settings store

`apps/fluux/src/stores/settingsStore.ts` — follow the existing `themeMode`/`timeFormat`
pattern exactly:

- `export type MediaAutoDownload = 'always' | 'private-only' | 'never'`
- `mediaAutoDownload: MediaAutoDownload` + `setMediaAutoDownload(value)`
- `localStorage` key `fluux-media-autodownload`
- `getInitialMediaAutoDownload()`: read + validate against the three values, fall back to
  `'private-only'`.

## Settings UI

New "Privacy" category (no existing category fits: "Storage" is `tauriOnly`, and this must
work on web too).

- `settings-components/types.ts`: add `'privacy'` to the `SettingsCategory` union and a
  `SETTINGS_CATEGORIES` entry `{ id: 'privacy', labelKey: 'settings.categories.privacy', icon: ShieldCheck }`
  (import `ShieldCheck` from `lucide-react`). Place it after `notifications`. The sidebar
  auto-derives from `getVisibleCategories()`, so no sidebar change is needed.
- `settings-components/PrivacySettings.tsx`: new component. The media-auto-download control
  reuses the **theme-mode button-grid pattern** from `AppearanceSettings.tsx` (3 buttons:
  Always / Private only / Never) plus a one-line description of the selected option. Below the
  control, a persistent static note clarifies the stranger hard-floor so `Always` is not
  misread as "everywhere": "Media from people who aren't in your contacts always needs a tap
  to load, whatever you choose here."
- `settings-components/index.ts`: export `PrivacySettings`.
- `SettingsView.tsx`: import `PrivacySettings`, add `case 'privacy': return <PrivacySettings />`.

## i18n

Add keys to **all 33 locale files** in `apps/fluux/src/i18n/locales/`, English first, then
translated values for every other locale. No em-dash (`—`/`–`) clause connectors — use a
period + capital, comma, or colon.

```
settings.categories.privacy                      "Privacy"
settings.mediaAutoDownload                        "Auto-download media"
settings.mediaAutoDownloadDescription             "Choose when images, videos, and files load automatically."
settings.mediaAutoDownloadAlways                  "Always"
settings.mediaAutoDownloadAlwaysDescription       "Load media automatically in every conversation."
settings.mediaAutoDownloadPrivateOnly             "Private only"
settings.mediaAutoDownloadPrivateOnlyDescription  "Load automatically in direct messages and private rooms. In public channels, tap to load."
settings.mediaAutoDownloadNever                   "Never"
settings.mediaAutoDownloadNeverDescription        "Never load media automatically. Tap to load in any conversation."
settings.mediaAutoDownloadStrangerNote            "Media from people who aren't in your contacts always needs a tap to load, whatever you choose here."
chat.loadImage                                    "Load image"
chat.loadVideo                                    "Load video"
chat.loadAudio                                    "Load audio"
chat.loadFilePreview                              "Load preview"
chat.showLinkImage                                "Show image"
```

## Testing

- `mediaAutoload.test.ts`: `computeMediaAutoload` full matrix (3 policies × 4 trust levels =
  12 cases), explicitly asserting `direct-stranger` is `false` under **all** policies
  (including `always`); `approveMediaUrl`/`isMediaUrlApproved` round-trip.
- `settingsStore` test: default is `'private-only'`; `setMediaAutoDownload` persists to
  `localStorage`; an invalid stored value falls back to the default.
- Representative component test (`FileAttachments` / `ImageAttachment`): with
  `MediaAutoloadProvider autoLoad={false}` it renders the placeholder and does **not** call the
  fetch hook; activating the placeholder triggers load and then renders the image. (Mock
  `useAttachmentUrl`.)
- Existing `ChatView`/`RoomView` tests already mock `MessageAttachments`; adding a provider
  wrapper must not break them. Confirm `useMediaAutoload`'s no-provider default keeps
  `SearchContextView` rendering unchanged.
- `ChatView` derives stranger status from the existing `useContactIdentities()` map
  (`contactsByJid.has(peerJid)`), already used/mocked in `ChatView` tests — no new
  `@fluux/sdk` mock surface. Add/confirm a case where the peer is absent from the map
  (stranger) and assert media defers even when the policy is `always`.

## Verification (demo mode)

In demo mode (`npm run dev` → `demo.html`): a public room with image/video attachments shows
placeholders under the default policy; tapping loads inline; a 1:1 chat and a private room
auto-load. Switching the Privacy setting to "Always" auto-loads everywhere; "Never" defers
everywhere. Confirm no layout shift / scroll jump when a placeholder is replaced by loaded
media.

## Out of scope (YAGNI)

- Per-room "always load here" override.
- Per-occupant contact-aware gating *inside* rooms (the room-level public/private signal
  governs rooms; we do not check whether each individual poster is a contact).
- Any setting to relax the stranger hard-floor (intentionally not configurable).
- Bandwidth / file-size-cap auto-download rules (e.g. "auto-load under 1 MB").
- Persisting tap-approval across app restarts (session-only is intentional).
- `SearchContextView`: keeps today's auto-load (no provider → default `true`). Search is
  explicitly user-initiated over a small result set; documented limitation, not a regression.

## File-by-file change list

New:
- `apps/fluux/src/utils/mediaAutoload.ts` (+ `.test.ts`)
- `apps/fluux/src/contexts/MediaAutoloadContext.tsx`
- `apps/fluux/src/components/DeferredMediaPlaceholder.tsx`
- `apps/fluux/src/components/settings-components/PrivacySettings.tsx`

Edited:
- `apps/fluux/src/stores/settingsStore.ts` — add `mediaAutoDownload` + setter + persistence.
- `apps/fluux/src/components/FileAttachments.tsx` — gate Image/Video/Audio, render placeholder.
- `apps/fluux/src/components/TextFilePreview.tsx` — gate `useTextPreview`, render placeholder.
- `apps/fluux/src/components/LinkPreviewCard.tsx` — gate the `<img>`, "Show image" affordance.
- `apps/fluux/src/components/RoomView.tsx` — wrap message list in `MediaAutoloadProvider`.
- `apps/fluux/src/components/ChatView.tsx` — derive trust from the existing
  `useContactIdentities()` map (`contactsByJid.has(peerJid)` → contact vs stranger) and wrap
  the `<ChatMessageList>` in `MediaAutoloadProvider`.
- `apps/fluux/src/components/settings-components/types.ts` — add `privacy` category.
- `apps/fluux/src/components/settings-components/index.ts` — export `PrivacySettings`.
- `apps/fluux/src/components/SettingsView.tsx` — route `privacy` → `PrivacySettings`.
- `apps/fluux/src/i18n/locales/*.json` — 33 files, new keys.
