/**
 * The bundle of vanilla Zustand stores an {@link XMPPClient} reads and writes.
 *
 * The client no longer reaches for the module-global store singletons directly:
 * it takes an `SDKStores` bundle (via `new XMPPClient({ stores })`), defaulting
 * to {@link defaultStores} — the process-wide singletons — so existing single-
 * account usage is unchanged.
 *
 * ---
 * MULTI-ACCOUNT (future work). Accepting a custom bundle is the *seam* for
 * running several accounts at once, but it is NOT sufficient on its own. Full
 * multi-account still needs:
 *
 * 1. A `createStores()` factory. Each store is a module singleton today
 *    (`export const chatStore = createStore(...)`); refactor to `createXStore()`
 *    factories (keeping the singletons as `defaultStores`) so every account gets
 *    an isolated set.
 * 2. Per-instance storage scope. `storageScope.ts` holds ONE module-global
 *    `currentStorageScopeJid`. Persisted stores (chat, ignore), the message
 *    cache (IndexedDB) and the search index already namespace by it
 *    (`buildScopedStorageKey` / `getStorageScopeJid`), so the keys are fine —
 *    but the scope must become per-bundle/per-client instead of a global, since
 *    only one account's scope can be active at a time right now.
 * 3. Threading the bundle through direct-global consumers. Anything that imports
 *    the raw singletons instead of reading `client.stores` (some side-effect
 *    submodules, utils) must take the bundle instead.
 * 4. The app's React layer. App hooks bind to the global singletons; multi-
 *    account needs an account-scoped context providing the active client +
 *    stores, with hooks resolving from it rather than the module singletons.
 */
import { connectionStore } from './connectionStore'
import { chatStore } from './chatStore'
import { rosterStore } from './rosterStore'
import { roomStore } from './roomStore'
import { eventsStore } from './eventsStore'
import { adminStore } from './adminStore'
import { blockingStore } from './blockingStore'
import { consoleStore } from './consoleStore'
import { ignoreStore } from './ignoreStore'

/**
 * The nine vanilla stores that back the {@link StoreBindings}. Each is a Zustand
 * `StoreApi` (get/set/subscribe). `searchStore` is intentionally excluded — it
 * is not part of the client's store bindings.
 */
export interface SDKStores {
  connection: typeof connectionStore
  chat: typeof chatStore
  roster: typeof rosterStore
  room: typeof roomStore
  events: typeof eventsStore
  admin: typeof adminStore
  blocking: typeof blockingStore
  console: typeof consoleStore
  ignore: typeof ignoreStore
}

/**
 * The process-wide singleton bundle. Used by {@link XMPPClient} when no custom
 * `stores` are injected, preserving today's single-account behaviour.
 */
export const defaultStores: SDKStores = {
  connection: connectionStore,
  chat: chatStore,
  roster: rosterStore,
  room: roomStore,
  events: eventsStore,
  admin: adminStore,
  blocking: blockingStore,
  console: consoleStore,
  ignore: ignoreStore,
}
