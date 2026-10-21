import { parseXmppUri, isMucJid, getBareJid, type LoginPrefill } from '@fluux/sdk'
import { platform } from '@/platform'
import { loginPrefillFromXmppUri } from '@/utils/loginPrefillSources'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'

/**
 * The one place deep links enter the app (desktop and iOS).
 *
 * The launch URL is read once and one live listener stays installed for the
 * whole app, so no screen reads the launch URL again when it mounts and no
 * listener outlives its screen. Where a link goes depends on who is listening:
 *
 * - while a startup reconnect is pending, a login link replaces the saved
 *   account (the startup owner decides how) and navigation waits for the
 *   connected app;
 * - while the chat view is up, every link navigates, as it always did;
 * - otherwise the login form is up: a login link prefills it and navigation
 *   waits for the next time the app is online.
 *
 * A login link names an account to sign in as (`xmpp:alice@example.com`,
 * `xmpp:alice@example.com?connect;server=…`); a room join, a message link or
 * a room address is navigation and never touches the login form.
 */
export type DeepLinkIntent = 'login' | 'navigation'

export function classifyDeepLink(uri: string): DeepLinkIntent {
  if (!uri.startsWith('xmpp:')) return 'navigation'
  const parsed = parseXmppUri(uri)
  if (!parsed) return 'navigation'
  // An explicit sign-in intent wins over any guess about the address.
  if (parsed.action === 'connect') return 'login'
  if (parsed.action === 'join' || parsed.action === 'message') return 'navigation'
  if (isMucJid(getBareJid(parsed.jid))) return 'navigation'
  return 'login'
}

/** How long a caller waits for the launch URL before carrying on without it. */
export const LAUNCH_LINK_WAIT_MS = 1500

type NavigationHandler = (uri: string) => void
type StartupLoginHandler = (prefill: LoginPrefill, uri: string) => void

let startupLoginHandler: StartupLoginHandler | null = null
let navigationHandler: NavigationHandler | null = null
const queuedNavigation: string[] = []
let launchRead: Promise<void> | null = null

function loginPrefillOf(uri: string): LoginPrefill | null {
  return classifyDeepLink(uri) === 'login' ? loginPrefillFromXmppUri(uri) : null
}

/** Dispatch one link according to who is listening (see the module doc). */
export function routeDeepLink(uri: string): void {
  console.log('[DeepLink] Received URI:', uri)
  if (startupLoginHandler) {
    const prefill = loginPrefillOf(uri)
    if (prefill) {
      startupLoginHandler(prefill, uri)
    } else {
      queuedNavigation.push(uri)
    }
    return
  }
  if (navigationHandler) {
    navigationHandler(uri)
    return
  }
  const prefill = loginPrefillOf(uri)
  if (prefill) {
    useLoginPrefillStore.getState().setPrefill(prefill)
  } else {
    queuedNavigation.push(uri)
  }
}

/**
 * Install the live listener and read the launch URL, once per app. Resolves
 * when the launch URL has been dispatched, or after {@link LAUNCH_LINK_WAIT_MS}
 * if the plugin does not answer in time (the listener keeps installing in the
 * background). Resolves at once where there are no deep link events (web).
 */
export function ensureDeepLinkRouter(): Promise<void> {
  if (!platform().hasDeepLinkEvents) return Promise.resolve()
  if (!launchRead) {
    const setup = (async () => {
      try {
        const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link')
        // Listener first, launch URL second: a link arriving in between is not lost.
        await onOpenUrl((urls) => { for (const url of urls) routeDeepLink(url) })
        const launch = await getCurrent()
        for (const url of launch ?? []) routeDeepLink(url)
      } catch (error) {
        console.error('[DeepLink] Failed to set up the deep link router:', error)
      }
    })()
    launchRead = Promise.race([
      setup,
      new Promise<void>((resolve) => { setTimeout(resolve, LAUNCH_LINK_WAIT_MS) }),
    ])
  }
  return launchRead
}

/**
 * The startup owner's say over login links while its reconnect is pending.
 * Navigation received meanwhile is queued for the connected app.
 */
export function setStartupLoginHandler(handler: StartupLoginHandler | null): void {
  startupLoginHandler = handler
}

/** The chat view's navigation; returns the disposer for its unmount. */
export function setNavigationHandler(handler: NavigationHandler): () => void {
  navigationHandler = handler
  return () => {
    if (navigationHandler === handler) navigationHandler = null
  }
}

/** Links that arrived before the app was online, oldest first; emptied by the call. */
export function takeQueuedDeepLinks(): string[] {
  return queuedNavigation.splice(0)
}

export function clearQueuedDeepLinks(): void {
  queuedNavigation.length = 0
}

/** Test-only: forget the listener, the handlers and the queue. */
export function resetDeepLinkRouterForTests(): void {
  startupLoginHandler = null
  navigationHandler = null
  queuedNavigation.length = 0
  launchRead = null
}
