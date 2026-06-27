# Connection Prefill Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an `xmpp:` link (desktop) or URL query params (web) open Fluux with the login form prefilled — JID, optional explicit server/WebSocket URL, optional resource/lang — never a password.

**Architecture:** One pure, validated `LoginPrefill` shape lives in the SDK. Two thin app-side adapters feed it: a desktop `xmpp:` deep-link handler (mounted on the login screen) and a web boot-time query-string parser. Both push into a small app-level Zustand store that `LoginScreen` consumes to seed its fields, revealing the advanced server field with a calm "a link set a custom server" note when a non-default endpoint is supplied.

**Tech Stack:** TypeScript, React, Zustand, Vitest, Tauri deep-link plugin (`@tauri-apps/plugin-deep-link`), i18next.

## Global Constraints

- **No new file format / extension / OS file-association** — desktop uses the already-registered `xmpp:` scheme; web uses query params.
- **No password or token is ever carried** — links only prefill; the user always types the password and presses Connect. No auto-connect from a link.
- **Server scheme allowlist:** an overridden server must parse as `ws:`, `wss:`, `http:`, or `https:`; anything else is dropped. This is the security gate.
- **Calm security affordance:** the custom-server note uses neutral gray (`text-fluux-muted`), never an alarm color (project "security iconography: calm by default" convention).
- **i18n:** any new user-facing key needs a genuine translation in all 33 locale files under `apps/fluux/src/i18n/locales/`; `i18n.test.ts` enforces key-set parity. No placeholders / English-in-other-locales.
- **No em-dashes or en-dashes in user-facing copy** (UI strings, translations).
- **Build order:** after changing SDK exports, run `npm run build:sdk` before app typecheck/tests (the app consumes the built package; the test mock spreads `importOriginal`, so new real exports appear automatically once built).
- **Run app vitest from `apps/fluux`** (the repo-root vitest config lacks the `@` alias). SDK vitest runs from `packages/fluux-sdk`.
- Before claiming done: `npm test`, `npm run typecheck`, and the linter must pass with no errors or stderr.

---

## File Structure

**SDK (`packages/fluux-sdk/`)**
- Create `src/utils/loginPrefill.ts` — `LoginPrefill` interface + pure `normalizeLoginPrefill()`.
- Create `src/utils/loginPrefill.test.ts` — pure unit tests.
- Modify `src/index.ts` — export the new symbol + type.

**App (`apps/fluux/`)**
- Create `src/stores/loginPrefillStore.ts` — Zustand slice `{ prefill, setPrefill, clearPrefill }`.
- Create `src/stores/loginPrefillStore.test.ts`.
- Create `src/utils/loginPrefillSources.ts` — `loginPrefillFromXmppUri()` + `captureWebLoginPrefill()`.
- Create `src/utils/loginPrefillSources.test.ts`.
- Create `src/hooks/useLoginPrefillDeepLink.ts` — desktop deep-link → store, mounted by LoginScreen.
- Create `src/hooks/useLoginPrefillDeepLink.test.tsx`.
- Modify `src/main.tsx` — web boot capture → store.
- Modify `src/components/LoginScreen.tsx` — consume store, seed fields, reveal server + note, apply resource/lang, skip keychain when a link is present.
- Modify `src/components/LoginScreen.test.tsx` (or create if absent) — seed + note + precedence.
- Modify all 33 `src/i18n/locales/*.json` — add `login.linkSetServer`.

---

## Task 1: SDK `normalizeLoginPrefill` (pure)

**Files:**
- Create: `packages/fluux-sdk/src/utils/loginPrefill.ts`
- Test: `packages/fluux-sdk/src/utils/loginPrefill.test.ts`
- Modify: `packages/fluux-sdk/src/index.ts` (after line 498, near the other `utils/` exports)

**Interfaces:**
- Produces:
  - `interface LoginPrefill { jid?: string; server?: string; resource?: string; lang?: string }`
  - `function normalizeLoginPrefill(raw: Record<string, string | undefined>): LoginPrefill | null`

- [ ] **Step 1: Write the failing test**

Create `packages/fluux-sdk/src/utils/loginPrefill.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { normalizeLoginPrefill } from './loginPrefill'

describe('normalizeLoginPrefill', () => {
  it('keeps a valid jid and ws server', () => {
    expect(
      normalizeLoginPrefill({ jid: 'alice@example.com', server: 'wss://host:5443/ws' })
    ).toEqual({ jid: 'alice@example.com', server: 'wss://host:5443/ws' })
  })

  it('accepts an http(s) BOSH server', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'https://b.com/http-bind' }))
      .toEqual({ jid: 'a@b.com', server: 'https://b.com/http-bind' })
  })

  it('drops a server with a disallowed scheme but keeps the jid', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'javascript:alert(1)' }))
      .toEqual({ jid: 'a@b.com' })
  })

  it('drops a server that is not a URL', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'not a url' }))
      .toEqual({ jid: 'a@b.com' })
  })

  it('strips a resource from the jid path', () => {
    expect(normalizeLoginPrefill({ jid: 'alice@example.com/phone' }))
      .toEqual({ jid: 'alice@example.com' })
  })

  it('accepts a bare domain jid', () => {
    expect(normalizeLoginPrefill({ jid: 'example.com' })).toEqual({ jid: 'example.com' })
  })

  it('rejects a malformed jid (no domain dot, no @)', () => {
    expect(normalizeLoginPrefill({ jid: 'nonsense' })).toBeNull()
  })

  it('trims and keeps resource and lang', () => {
    expect(
      normalizeLoginPrefill({ jid: 'a@b.com', resource: ' desktop ', lang: ' fr ' })
    ).toEqual({ jid: 'a@b.com', resource: 'desktop', lang: 'fr' })
  })

  it('returns null when nothing usable is present', () => {
    expect(normalizeLoginPrefill({})).toBeNull()
    expect(normalizeLoginPrefill({ resource: 'x', lang: 'y' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/loginPrefill.test.ts`
Expected: FAIL — cannot resolve `./loginPrefill` / `normalizeLoginPrefill is not a function`.

- [ ] **Step 3: Write the implementation**

Create `packages/fluux-sdk/src/utils/loginPrefill.ts`:

```typescript
/**
 * Login prefill — the validated, transport-agnostic shape used to preconfigure
 * the login screen from an xmpp: link (desktop) or URL query params (web).
 *
 * Never carries a password or token: a prefill only seeds the form, the user
 * always types their password and presses Connect.
 */
export interface LoginPrefill {
  /** Full JID 'local@domain' or a bare domain. */
  jid?: string
  /** Advanced server field: a ws/wss/http(s) service URL. */
  server?: string
  /** Optional XMPP resource. */
  resource?: string
  /** Optional UI / xml:lang language tag. */
  lang?: string
}

// Security gate: only these schemes may be set as the connection target.
const ALLOWED_SERVER_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:'])

function normalizeJid(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  // Strip any resource, then validate the bare JID shape.
  const jid = raw.trim().split('/')[0]
  if (!jid || /\s/.test(jid)) return undefined
  const at = jid.indexOf('@')
  if (at === -1) {
    // Bare domain: must look like a hostname (contains a dot, no '@' or '/').
    return /^[^\s@/]+\.[^\s@/]+$/.test(jid) ? jid : undefined
  }
  const local = jid.slice(0, at)
  const domain = jid.slice(at + 1)
  if (!local || !domain || domain.includes('@')) return undefined
  return jid
}

function normalizeServer(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ALLOWED_SERVER_PROTOCOLS.has(url.protocol) ? value : undefined
  } catch {
    return undefined
  }
}

function normalizeToken(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  return value ? value : undefined
}

/**
 * Validate a loose record of prefill fields into a clean {@link LoginPrefill}.
 * Returns null when neither a usable jid nor a usable server survives, so
 * callers can fall straight through to the normal login screen.
 */
export function normalizeLoginPrefill(
  raw: Record<string, string | undefined>
): LoginPrefill | null {
  const jid = normalizeJid(raw.jid)
  const server = normalizeServer(raw.server)
  const resource = normalizeToken(raw.resource)
  const lang = normalizeToken(raw.lang)

  if (!jid && !server) return null

  const result: LoginPrefill = {}
  if (jid) result.jid = jid
  if (server) result.server = server
  if (resource) result.resource = resource
  if (lang) result.lang = lang
  return result
}
```

- [ ] **Step 4: Add the export**

In `packages/fluux-sdk/src/index.ts`, after line 498 (the `parseXmppUri` / `XmppUri` exports), add:

```typescript
export { normalizeLoginPrefill } from './utils/loginPrefill'
export type { LoginPrefill } from './utils/loginPrefill'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/loginPrefill.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Build the SDK so the app sees the new exports**

Run: `npm run build:sdk`
Expected: completes with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/utils/loginPrefill.ts packages/fluux-sdk/src/utils/loginPrefill.test.ts packages/fluux-sdk/src/index.ts
git commit -m "feat(sdk): add normalizeLoginPrefill for login prefill links"
```

---

## Task 2: App `loginPrefillStore`

**Files:**
- Create: `apps/fluux/src/stores/loginPrefillStore.ts`
- Test: `apps/fluux/src/stores/loginPrefillStore.test.ts`

**Interfaces:**
- Consumes: `LoginPrefill` (Task 1).
- Produces: `useLoginPrefillStore` with state `{ prefill: LoginPrefill | null; setPrefill(p: LoginPrefill): void; clearPrefill(): void }`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/stores/loginPrefillStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useLoginPrefillStore } from './loginPrefillStore'

describe('loginPrefillStore', () => {
  beforeEach(() => {
    useLoginPrefillStore.getState().clearPrefill()
  })

  it('starts empty', () => {
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
  })

  it('stores a prefill', () => {
    useLoginPrefillStore.getState().setPrefill({ jid: 'a@b.com', server: 'wss://b.com/ws' })
    expect(useLoginPrefillStore.getState().prefill).toEqual({ jid: 'a@b.com', server: 'wss://b.com/ws' })
  })

  it('clears a prefill', () => {
    useLoginPrefillStore.getState().setPrefill({ jid: 'a@b.com' })
    useLoginPrefillStore.getState().clearPrefill()
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/stores/loginPrefillStore.test.ts`
Expected: FAIL — cannot resolve `./loginPrefillStore`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/stores/loginPrefillStore.ts`:

```typescript
import { create } from 'zustand'
import type { LoginPrefill } from '@fluux/sdk'

/**
 * Holds a one-shot login prefill produced by an xmpp: deep link (desktop) or
 * URL query params (web). LoginScreen consumes it to seed its fields, then
 * clears it so it does not bleed across a later logout.
 *
 * App-level UI state (not an SDK store): the prefill only ever touches the
 * login form, never the XMPP connection directly.
 */
interface LoginPrefillState {
  prefill: LoginPrefill | null
  setPrefill: (prefill: LoginPrefill) => void
  clearPrefill: () => void
}

export const useLoginPrefillStore = create<LoginPrefillState>((set) => ({
  prefill: null,
  setPrefill: (prefill) => set({ prefill }),
  clearPrefill: () => set({ prefill: null }),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/stores/loginPrefillStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/stores/loginPrefillStore.ts apps/fluux/src/stores/loginPrefillStore.test.ts
git commit -m "feat(app): add loginPrefillStore"
```

---

## Task 3: App prefill source adapters (xmpp URI + web query)

**Files:**
- Create: `apps/fluux/src/utils/loginPrefillSources.ts`
- Test: `apps/fluux/src/utils/loginPrefillSources.test.ts`
- Modify: `apps/fluux/src/main.tsx`

**Interfaces:**
- Consumes: `parseXmppUri`, `normalizeLoginPrefill`, `LoginPrefill` (SDK); `useLoginPrefillStore` (Task 2).
- Produces:
  - `function loginPrefillFromXmppUri(uri: string): LoginPrefill | null`
  - `function captureWebLoginPrefill(): LoginPrefill | null` (also strips the consumed params from the URL)

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/loginPrefillSources.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { loginPrefillFromXmppUri, captureWebLoginPrefill } from './loginPrefillSources'

describe('loginPrefillFromXmppUri', () => {
  it('parses a bare jid uri', () => {
    expect(loginPrefillFromXmppUri('xmpp:alice@example.com')).toEqual({ jid: 'alice@example.com' })
  })

  it('parses a connect uri with a server override', () => {
    const uri = 'xmpp:alice@example.com?connect;server=wss%3A%2F%2Fhost%3A5443%2Fws;resource=desktop'
    expect(loginPrefillFromXmppUri(uri)).toEqual({
      jid: 'alice@example.com',
      server: 'wss://host:5443/ws',
      resource: 'desktop',
    })
  })

  it('returns null for a non-xmpp uri', () => {
    expect(loginPrefillFromXmppUri('https://example.com')).toBeNull()
  })
})

describe('captureWebLoginPrefill', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('returns null when no prefill params are present', () => {
    window.history.replaceState(null, '', '/?foo=bar#/chat')
    expect(captureWebLoginPrefill()).toBeNull()
    expect(window.location.search).toBe('?foo=bar')
  })

  it('parses jid and server and strips them from the url', () => {
    window.history.replaceState(null, '', '/?jid=alice@example.com&server=wss://host/ws&keep=1#/x')
    expect(captureWebLoginPrefill()).toEqual({ jid: 'alice@example.com', server: 'wss://host/ws' })
    // consumed params removed, unrelated params + hash preserved
    expect(window.location.search).toBe('?keep=1')
    expect(window.location.hash).toBe('#/x')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/loginPrefillSources.test.ts`
Expected: FAIL — cannot resolve `./loginPrefillSources`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/utils/loginPrefillSources.ts`:

```typescript
import { parseXmppUri, normalizeLoginPrefill, type LoginPrefill } from '@fluux/sdk'

/**
 * Desktop: turn an incoming xmpp: deep link into a validated login prefill.
 * A bare `xmpp:alice@example.com` prefills just the JID; a `?connect` action
 * carries the optional server/resource/lang overrides.
 */
export function loginPrefillFromXmppUri(uri: string): LoginPrefill | null {
  const parsed = parseXmppUri(uri)
  if (!parsed) return null
  return normalizeLoginPrefill({
    jid: parsed.jid,
    server: parsed.params.server,
    resource: parsed.params.resource,
    lang: parsed.params.lang,
  })
}

const WEB_PREFILL_PARAMS = ['jid', 'server', 'resource', 'lang'] as const

/**
 * Web: read prefill params from the current URL query string, validate them,
 * and strip them from the URL (preserving any other params and the hash route)
 * so a manual reload does not re-fire and the values do not linger in the bar.
 */
export function captureWebLoginPrefill(): LoginPrefill | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (!WEB_PREFILL_PARAMS.some((key) => params.has(key))) return null

  const prefill = normalizeLoginPrefill({
    jid: params.get('jid') ?? undefined,
    server: params.get('server') ?? undefined,
    resource: params.get('resource') ?? undefined,
    lang: params.get('lang') ?? undefined,
  })

  for (const key of WEB_PREFILL_PARAMS) params.delete(key)
  const query = params.toString()
  const newUrl = window.location.pathname + (query ? `?${query}` : '') + window.location.hash
  window.history.replaceState(null, '', newUrl)

  return prefill
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/loginPrefillSources.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the web capture into boot**

In `apps/fluux/src/main.tsx`:

Add imports near the other local imports (after line 18):

```typescript
import { captureWebLoginPrefill } from './utils/loginPrefillSources'
import { useLoginPrefillStore } from './stores/loginPrefillStore'
```

Then, immediately after the `if (!isTauri) { registerServiceWorker() }` block (after line 33), add:

```typescript
// Web: capture any login-prefill params from the launch URL (e.g. a shared
// link) and stash them for LoginScreen to seed. Desktop uses the xmpp: deep
// link path instead. Runs once at boot, before React mounts.
if (!isTauri) {
  const webPrefill = captureWebLoginPrefill()
  if (webPrefill) {
    useLoginPrefillStore.getState().setPrefill(webPrefill)
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). If `LoginPrefill` is unresolved, confirm Task 1 Step 6 (`npm run build:sdk`) ran.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/utils/loginPrefillSources.ts apps/fluux/src/utils/loginPrefillSources.test.ts apps/fluux/src/main.tsx
git commit -m "feat(app): parse login prefill from xmpp uri and web url params"
```

---

## Task 4: Desktop deep-link → prefill hook

**Files:**
- Create: `apps/fluux/src/hooks/useLoginPrefillDeepLink.ts`
- Test: `apps/fluux/src/hooks/useLoginPrefillDeepLink.test.tsx`

**Interfaces:**
- Consumes: `loginPrefillFromXmppUri` (Task 3), `useLoginPrefillStore` (Task 2), `@tauri-apps/plugin-deep-link` (`onOpenUrl`, `getCurrent`).
- Produces: `function useLoginPrefillDeepLink(): void` — mounted by LoginScreen (Task 5).

Note: this is the login-screen counterpart to `useDeepLink` (mounted in `ChatLayout`). The two are mutually exclusive — LoginScreen is mounted only when logged out, ChatLayout only when connected — so their deep-link subscriptions never overlap.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/useLoginPrefillDeepLink.test.tsx`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLoginPrefillDeepLink } from './useLoginPrefillDeepLink'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'

describe('useLoginPrefillDeepLink', () => {
  beforeEach(() => {
    useLoginPrefillStore.getState().clearPrefill()
  })

  it('is a no-op outside Tauri (does not set a prefill or throw)', () => {
    // jsdom has no __TAURI_INTERNALS__, so the hook should not touch the store.
    expect(() => renderHook(() => useLoginPrefillDeepLink())).not.toThrow()
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useLoginPrefillDeepLink.test.tsx`
Expected: FAIL — cannot resolve `./useLoginPrefillDeepLink`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/hooks/useLoginPrefillDeepLink.ts`:

```typescript
import { useEffect } from 'react'
import { loginPrefillFromXmppUri } from '@/utils/loginPrefillSources'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Desktop-only: while the user is on the login screen, route incoming xmpp:
 * deep links to a login prefill instead of in-app navigation. Covers both the
 * cold-start launch URL (double-clicking a link with the app closed) and a
 * link clicked while the login screen is already open.
 *
 * Mounted by LoginScreen. Mutually exclusive with ChatLayout's useDeepLink,
 * which owns navigation once the user is connected.
 */
export function useLoginPrefillDeepLink(): void {
  useEffect(() => {
    if (!isTauri) return

    let cleanup: (() => void) | undefined
    let cleanedUp = false

    const apply = (urls: string[]) => {
      for (const url of urls) {
        const prefill = loginPrefillFromXmppUri(url)
        if (prefill) {
          useLoginPrefillStore.getState().setPrefill(prefill)
          break
        }
      }
    }

    const setup = async () => {
      try {
        const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link')
        const unlisten = await onOpenUrl((urls) => apply(urls))
        if (cleanedUp) {
          unlisten()
          return
        }
        const initial = await getCurrent()
        if (initial && initial.length > 0) apply(initial)
        cleanup = unlisten
      } catch (error) {
        console.error('[LoginPrefill] Failed to set up deep link handler:', error)
      }
    }

    void setup()

    return () => {
      cleanedUp = true
      cleanup?.()
    }
  }, [])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useLoginPrefillDeepLink.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useLoginPrefillDeepLink.ts apps/fluux/src/hooks/useLoginPrefillDeepLink.test.tsx
git commit -m "feat(app): route xmpp: deep links to login prefill on the login screen"
```

---

## Task 5: i18n key for the custom-server note

**Files:**
- Modify: all 33 files in `apps/fluux/src/i18n/locales/*.json` — add `login.linkSetServer`.

The string interpolates the host: `{{host}}`. Add the key inside each file's existing `login` object (alongside `serverLabel` etc.). No em-dashes / en-dashes. Translations:

| file | value for `login.linkSetServer` |
|------|--------------------------------|
| `ar.json` | `قام رابط بتعيين خادم مخصص: {{host}}` |
| `be.json` | `Спасылка задала ўласны сервер: {{host}}` |
| `bg.json` | `Връзка зададе персонализиран сървър: {{host}}` |
| `ca.json` | `Un enllaç ha definit un servidor personalitzat: {{host}}` |
| `cs.json` | `Odkaz nastavil vlastní server: {{host}}` |
| `da.json` | `Et link angav en brugerdefineret server: {{host}}` |
| `de.json` | `Ein Link hat einen benutzerdefinierten Server festgelegt: {{host}}` |
| `el.json` | `Ένας σύνδεσμος όρισε προσαρμοσμένο διακομιστή: {{host}}` |
| `en.json` | `A link set a custom server: {{host}}` |
| `es.json` | `Un enlace estableció un servidor personalizado: {{host}}` |
| `et.json` | `Link määras kohandatud serveri: {{host}}` |
| `fi.json` | `Linkki asetti mukautetun palvelimen: {{host}}` |
| `fr.json` | `Un lien a défini un serveur personnalisé : {{host}}` |
| `ga.json` | `Shocraigh nasc freastalaí saincheaptha: {{host}}` |
| `he.json` | `קישור הגדיר שרת מותאם אישית: {{host}}` |
| `hr.json` | `Poveznica je postavila prilagođeni poslužitelj: {{host}}` |
| `hu.json` | `Egy hivatkozás egyéni kiszolgálót állított be: {{host}}` |
| `is.json` | `Tengill stillti sérsniðinn netþjón: {{host}}` |
| `it.json` | `Un link ha impostato un server personalizzato: {{host}}` |
| `lt.json` | `Nuoroda nustatė pasirinktinį serverį: {{host}}` |
| `lv.json` | `Saite iestatīja pielāgotu serveri: {{host}}` |
| `mt.json` | `Link issettja server personalizzat: {{host}}` |
| `nb.json` | `En lenke angav en egendefinert server: {{host}}` |
| `nl.json` | `Een koppeling heeft een aangepaste server ingesteld: {{host}}` |
| `pl.json` | `Łącze ustawiło niestandardowy serwer: {{host}}` |
| `pt.json` | `Uma ligação definiu um servidor personalizado: {{host}}` |
| `ro.json` | `Un link a setat un server personalizat: {{host}}` |
| `ru.json` | `Ссылка задала пользовательский сервер: {{host}}` |
| `sk.json` | `Odkaz nastavil vlastný server: {{host}}` |
| `sl.json` | `Povezava je nastavila prilagojeni strežnik: {{host}}` |
| `sv.json` | `En länk angav en anpassad server: {{host}}` |
| `uk.json` | `Посилання задало власний сервер: {{host}}` |
| `zh-CN.json` | `链接设置了自定义服务器：{{host}}` |

- [ ] **Step 1: Add the key to every locale**

For each file above, add inside the `login` object a line:

```json
"linkSetServer": "<value from the table>",
```

(Place it near `serverHint`. Mind trailing-comma JSON validity.)

- [ ] **Step 2: Run the i18n parity test**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS — all locales share the same key set including `login.linkSetServer`; no missing-key failures.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n: add login.linkSetServer note for prefilled custom server"
```

---

## Task 6: LoginScreen consumes the prefill

**Files:**
- Modify: `apps/fluux/src/components/LoginScreen.tsx`
- Test: `apps/fluux/src/components/LoginScreen.test.tsx` (create if it does not exist)

**Interfaces:**
- Consumes: `useLoginPrefillStore` (Task 2), `useLoginPrefillDeepLink` (Task 4), `login.linkSetServer` (Task 5).

Behavior to implement:
1. Mount `useLoginPrefillDeepLink()` so desktop links reach the store while on the login screen.
2. Subscribe to the store's `prefill`; on a non-null value, seed `jid` / `server`, reveal the server field, set a host note, apply `resource` (submit) and `lang` (UI), then `clearPrefill()`.
3. When a prefill is present at mount, skip the keychain credential load (so a link to account B does not auto-connect saved account A).
4. Prefill beats the localStorage seed (it applies after the load effect).

- [ ] **Step 1: Write the failing test**

Create/replace `apps/fluux/src/components/LoginScreen.test.tsx`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { LoginScreen } from './LoginScreen'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'

// LoginScreen pulls connection state/actions from the mocked @fluux/sdk
// (see src/test-setup.ts). These tests only assert prefill seeding.

describe('LoginScreen prefill', () => {
  beforeEach(() => {
    localStorage.clear()
    useLoginPrefillStore.getState().clearPrefill()
  })

  it('seeds the JID field from a prefill', async () => {
    useLoginPrefillStore.getState().setPrefill({ jid: 'alice@example.com' })
    render(<LoginScreen />)
    const jidInput = await screen.findByLabelText(/jid|username|address/i)
    await waitFor(() => expect((jidInput as HTMLInputElement).value).toBe('alice@example.com'))
    // prefill is one-shot: cleared after consumption
    expect(useLoginPrefillStore.getState().prefill).toBeNull()
  })

  it('reveals the server field and shows the custom-server note', async () => {
    useLoginPrefillStore.getState().setPrefill({
      jid: 'alice@example.com',
      server: 'wss://custom.example.com:5443/ws',
    })
    render(<LoginScreen />)
    const serverInput = await screen.findByDisplayValue('wss://custom.example.com:5443/ws')
    expect(serverInput).toBeTruthy()
    // host shown in the calm note
    expect(await screen.findByText(/custom\.example\.com/)).toBeTruthy()
  })

  it('lets a prefill JID override the localStorage seed', async () => {
    localStorage.setItem('xmpp-last-jid', 'old@example.com')
    useLoginPrefillStore.getState().setPrefill({ jid: 'new@example.com' })
    render(<LoginScreen />)
    const jidInput = await screen.findByLabelText(/jid|username|address/i)
    await waitFor(() => expect((jidInput as HTMLInputElement).value).toBe('new@example.com'))
  })
})
```

Note: adjust the JID `findByLabelText` matcher to the field's actual `aria-label` / `<label>` text if these regexes do not match (inspect the rendered TextInput for the JID in `LoginScreen.tsx`). Keep the assertions; fix only the selector.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx`
Expected: FAIL — JID value stays empty / note not found (prefill not yet wired).

- [ ] **Step 3: Add imports and store subscription**

In `apps/fluux/src/components/LoginScreen.tsx`:

Add imports (after line 17, the `useAdvancedModeStore` import):

```typescript
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'
import { useLoginPrefillDeepLink } from '@/hooks/useLoginPrefillDeepLink'
```

Inside the component, just after `const advancedMode = useAdvancedModeStore(...)` / `setAdvancedMode` lines (around line 121), add:

```typescript
  // Login prefill from an xmpp: deep link (desktop) or URL params (web).
  useLoginPrefillDeepLink()
  const prefill = useLoginPrefillStore((s) => s.prefill)
  const clearPrefill = useLoginPrefillStore((s) => s.clearPrefill)
  // Host of a link-supplied custom server, shown as a calm note under the field.
  const [linkServerHost, setLinkServerHost] = useState<string | null>(null)
  // A link-supplied resource overrides getResource() at submit time.
  const linkResourceRef = useRef<string | undefined>(undefined)
```

- [ ] **Step 4: Skip the keychain load when a link prefill is present**

In the credential-loading effect, change the keychain guard so it is skipped when a prefill was supplied at mount. Replace the condition on line 156:

```typescript
      if (inTauri && hasSavedCredentials()) {
```

with:

```typescript
      // A link prefill represents explicit intent for a (possibly different)
      // account, so do not auto-load / auto-connect saved keychain credentials.
      const hasLinkPrefill = !!useLoginPrefillStore.getState().prefill
      if (inTauri && hasSavedCredentials() && !hasLinkPrefill) {
```

- [ ] **Step 5: Apply the prefill (after load, so it wins)**

Add a new effect after the "Show server field if a saved server value was loaded" effect (after line 210):

```typescript
  // Apply a login prefill (xmpp: link / URL params). Runs after the localStorage
  // and keychain seeds, so the link wins. One-shot: cleared after applying.
  useEffect(() => {
    if (!prefill) return
    if (prefill.jid) setJid(prefill.jid)
    if (prefill.server) {
      setServer(prefill.server)
      setShowServerField(true)
      setHasManuallySetServer(true) // stop web auto-fill from clobbering the link value
      try {
        setLinkServerHost(new URL(prefill.server).host)
      } catch {
        setLinkServerHost(null)
      }
    }
    if (prefill.resource) linkResourceRef.current = prefill.resource
    if (prefill.lang) void i18n.changeLanguage(prefill.lang)
    clearPrefill()
  }, [prefill, clearPrefill, i18n])
```

- [ ] **Step 6: Use the link resource at submit**

In `handleSubmit`, replace line 343:

```typescript
      const resource = getResource()
```

with:

```typescript
      const resource = linkResourceRef.current || getResource()
```

- [ ] **Step 7: Render the calm custom-server note**

In the server-field block, inside the `showServerField && (...)` fragment, after the existing hint `<p>` (after line 492), add:

```tsx
                {linkServerHost && (
                  <p className="text-xs text-fluux-muted mt-1">
                    {t('login.linkSetServer', { host: linkServerHost })}
                  </p>
                )}
```

- [ ] **Step 8: Run the LoginScreen test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx`
Expected: PASS (3 tests). If the JID selector did not match, fix only the `findByLabelText` regex per the Step 1 note, then re-run.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/components/LoginScreen.tsx apps/fluux/src/components/LoginScreen.test.tsx
git commit -m "feat(app): prefill the login screen from xmpp links and url params"
```

---

## Task 7: Full verification

- [ ] **Step 1: SDK tests**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: PASS, no stderr.

- [ ] **Step 2: Rebuild SDK + app test suite**

Run: `npm run build:sdk && cd apps/fluux && npx vitest run`
Expected: PASS, no stderr.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS, no errors.

- [ ] **Step 4: Manual smoke (optional, recommended)**

- Web: open `http://localhost:5173/?jid=alice@example.com&server=wss://chat.example.com/ws`, confirm the login form has the JID filled, the server field revealed with that URL, the calm note showing `chat.example.com`, and the query string stripped from the address bar.
- Desktop: with the app on the login screen, trigger `xmpp:alice@example.com?connect;server=wss%3A%2F%2Fchat.example.com%2Fws` (e.g. `open` on macOS) and confirm the same prefill.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for connection prefill links"
```

---

## Self-Review notes (addressed in this plan)

- **Spec coverage:** normalized shape + validation (Task 1); desktop `xmpp:` `connect` action + auth-gating via login-screen-only mount (Tasks 4/6); web query params + URL strip (Task 3); shared store delivery (Task 2); precedence over localStorage + keychain skip (Task 6); calm server note (Tasks 5/6); resource/lang applied (Task 6). All five spec sections map to tasks.
- **Auth-state gating** is realized structurally: the prefill deep-link hook is mounted only by `LoginScreen` (rendered only when logged out), and `ChatLayout`'s existing `useDeepLink` (navigation) is mounted only when connected. No new auth flag needed.
- **Type consistency:** `LoginPrefill` fields (`jid`/`server`/`resource`/`lang`), `normalizeLoginPrefill`, `useLoginPrefillStore` `{ prefill, setPrefill, clearPrefill }`, `loginPrefillFromXmppUri`, `captureWebLoginPrefill`, `useLoginPrefillDeepLink` are used identically across tasks.
