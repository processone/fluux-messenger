import { prepareNativePushAccount } from '@/hooks/useNativePush'
import { useEffect, useRef, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { connectionStore, useXMPPContext, useConnectionActions, getBareJid, getDomain, deleteFastToken } from '@fluux/sdk'
import { useRosterStore, useConnectionStore } from '@fluux/sdk/react'
import type { ConnectOptions, LoginPrefill } from '@fluux/sdk'
import { getResource } from '@/utils/xmppResource'
import { platform } from '@/platform'
import { getCredentials, hasSavedCredentials } from '@/utils/keychain'
import { getReconnectIntent } from '@/utils/reconnectIntent'
import { isShuttingDown } from '@/utils/appShutdown'
import { getConnectionServerOptions } from '@/config/wellKnownServers'
import { standaloneStartupReconnect } from '@/utils/startupReconnect'
import { buildStartupConnectionOptions } from '@/utils/startupConnectionOptions'
import { prewarmOpenpgpUnlock } from '@/utils/openpgpPrewarm'
import { ensureDeepLinkRouter, setStartupLoginHandler, clearQueuedDeepLinks } from '@/utils/deepLinkRouter'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'
import {
  clearSession,
  getSession,
  saveSession,
  getSavedRoster,
  getSavedServerInfo,
  getSavedProfile,
  getSavedOwnResources,
  type SessionData,
} from '@/utils/sessionStorage'

/** What `useSessionPersistence` reports to the screen that renders by it. */
export interface SessionPersistence {
  /**
   * True while the startup reconnect is still being decided or is in flight:
   * from the first render when a remembered credential exists, until the
   * connection is online or the startup is over without one (nothing usable,
   * another tab holds the account, a real failure after the permitted
   * fallback, a cancelled reconnect, a logout, or a login link that replaced
   * the saved account). While true the login form is never the right screen.
   */
  startupPending: boolean
}

/**
 * Whether a reopen will reconnect by itself: a tab session, a remembered FAST
 * token or a native keychain password, unless the user logged out, the app is
 * quitting, or a login link (web: URL parameters) names another account.
 */
export function startupReconnectExpected(): boolean {
  if (getReconnectIntent() === 'logged-out' || isShuttingDown()) return false
  if (useLoginPrefillStore.getState().prefill) return false
  return getSession() !== null || standaloneStartupReconnect() !== null
}

/**
 * Hook to auto-reconnect on page reload if session exists.
 * Uses sessionStorage which persists across reload but clears when tab closes.
 * Supports XEP-0198 Stream Management for faster session resumption.
 *
 * This hook is the single owner of the startup reconnect: it chooses the
 * credential (tab session, FAST token, keychain password), runs the attempt
 * and its one permitted keychain fallback, honours a login link that replaces
 * the saved account at any point, and reports `startupPending` so the screen
 * shows the account's cached conversations instead of the login form until
 * the outcome is known.
 */
export function useSessionPersistence(claimConnection?: (jid: string) => Promise<boolean>): SessionPersistence {
  const { i18n } = useTranslation()
  const { client } = useXMPPContext()
  // NOTE: Only subscribe to status - we need this to gate effects.
  // All other values are read via getState() to avoid render loops during connection
  // when serverInfo, httpUploadService, ownAvatarHash, etc. update frequently.
  const status = useConnectionStore((s) => s.status)
  // NOTE: We intentionally do NOT subscribe to contacts or rooms Maps here.
  // Subscribing to entire Maps causes render loops during connection when many
  // contacts/rooms are loaded. Instead, we access them via .getState() when
  // needed (in beforeunload handler) and save periodically with an interval.
  const setContacts = useRosterStore((s) => s.setContacts)
  const setServerInfo = useConnectionStore((s) => s.setServerInfo)
  const setHttpUploadService = useConnectionStore((s) => s.setHttpUploadService)
  const setOwnNickname = useConnectionStore((s) => s.setOwnNickname)
  const updateOwnResource = useConnectionStore((s) => s.updateOwnResource)
  const autoReconnectCheckedRef = useRef(false)
  const isResumptionRef = useRef(false)
  const keychainRetryAttempted = useRef(false)

  // Decided synchronously on the first render, so the caller never paints the
  // login form ahead of a reconnect that is about to start.
  const [startupPending, setStartupPending] = useState(startupReconnectExpected)
  // Identifies the current startup attempt. A login link that replaces the
  // saved account bumps it, so every pending step of the old attempt stops
  // at its next check and nothing it does afterwards is saved.
  const startupEpochRef = useRef(0)
  const clientRef = useRef(client)
  clientRef.current = client

  // Reuse the SDK's connect action: it performs the identical connecting/error
  // status wrapping around client.connect() and takes a ConnectOptions object.
  // useConnectionActions() does zero store subscriptions, so it adds no renders.
  const { connect } = useConnectionActions()

  // Note: SM state is now managed by SDK's storage adapter.
  // The SDK automatically loads SM state on connect and persists it on enable/resume.

  // Restore avatar from cache without subscribing to store
  const restoreOwnAvatarFromCache = useCallback(async (avatarHash: string) => {
    return client.profile.restoreOwnAvatarFromCache(avatarHash)
  }, [client])

  // Every way a startup ends goes through here.
  const endStartup = useCallback(() => {
    setStartupPending(false)
    setStartupLoginHandler(null)
  }, [])

  const startupObsolete = useCallback(
    (epoch: number) => epoch !== startupEpochRef.current || getReconnectIntent() === 'logged-out' || isShuttingDown(),
    [],
  )

  // The one place a startup path connects. Nothing happens for an attempt that
  // was replaced by a login link, logged out or overtaken by a shutdown in the
  // meantime, and the caller saves nothing for one that was while connecting.
  // Rejects when the connection fails or is cancelled (status then says so).
  const startupConnect = useCallback(async (epoch: number, options: ConnectOptions): Promise<boolean> => {
    if (startupObsolete(epoch)) return false
    await connect(options)
    return !startupObsolete(epoch)
  }, [connect, startupObsolete])

  // A login link replaces the saved account at any moment during startup: the
  // attempt is abandoned, a connection in flight is cancelled, navigation
  // received for the abandoned account is dropped, and the login form takes
  // the link's account.
  const abandonStartup = useCallback((epoch: number, prefill: LoginPrefill) => {
    if (epoch !== startupEpochRef.current) return
    startupEpochRef.current += 1
    clearQueuedDeepLinks()
    useLoginPrefillStore.getState().setPrefill(prefill)
    if (connectionStore.getState().status !== 'disconnected') void clientRef.current.disconnect()
    endStartup()
  }, [endStartup])

  // ── Path A: sessionStorage has credentials (page reload within same tab) ──
  // SM resumption is attempted first by the SDK. We restore cached state
  // in case SM succeeds (server only sends deltas).
  const reconnectFromSession = useCallback(async (epoch: number, session: SessionData) => {
    isResumptionRef.current = true

    // Restore roster (for SM resumption case where server sends deltas)
    const savedRoster = getSavedRoster(session.jid)
    if (savedRoster) {
      setContacts(savedRoster, getBareJid(session.jid))
    }

    // Restore server discovery info
    const savedServerInfo = getSavedServerInfo(session.jid)
    if (savedServerInfo) {
      if (savedServerInfo.serverInfo) {
        setServerInfo(savedServerInfo.serverInfo)
      }
      if (savedServerInfo.httpUploadService) {
        setHttpUploadService(savedServerInfo.httpUploadService)
      }
    }

    // Note: Presence state is now restored by XState machine's native persistence
    // in XMPPProvider (key: 'fluux:presence-machine')

    // Restore profile data (nickname, avatar from cache)
    const savedProfile = getSavedProfile(session.jid)
    if (savedProfile) {
      if (savedProfile.ownNickname) {
        setOwnNickname(savedProfile.ownNickname)
      }
    }

    // Restore own resources (other connected devices)
    const savedOwnResources = getSavedOwnResources(session.jid)
    if (savedOwnResources && savedOwnResources.size > 0) {
      savedOwnResources.forEach((resource, resourceKey) => {
        updateOwnResource(resourceKey, resource.show, resource.priority, resource.status, resource.lastInteraction, resource.client)
      })
    }

    // Auto-reconnect with stored credentials (password from sessionStorage)
    // Note: SDK automatically loads SM state from storage and attempts resumption
    // Room joining is now handled by the SDK's readStateStorage, not sessionStorage
    const resource = getResource()
    const hasNativeConnectionKeepalive = platform().hasNativeConnectionKeepalive
    console.log('[Auth] Reconnecting on page reload with password (SDK will attempt SM resumption first)')

    const rememberSession = localStorage.getItem('xmpp-remember-me') === 'true' || undefined
    const serverOptions = getConnectionServerOptions(session.jid, session.server)

    // Check if another tab already holds this JID (web only)
    if (claimConnection) {
      // A failed claim check is not a blocked tab: try connecting anyway.
      const canConnect = await claimConnection(session.jid).catch(() => true)
      if (!canConnect) {
        console.log('[Auth] Another tab already connected, skipping auto-reconnect')
        isResumptionRef.current = false
        return
      }
    }

    try {
      await prepareNativePushAccount(session.jid)
      const connecting = startupConnect(epoch, buildStartupConnectionOptions(
        { jid: session.jid, password: session.password, ...serverOptions, resource, lang: i18n.language },
        { kind: 'session', hasNativeConnectionKeepalive, rememberSession },
      ))
      if (savedProfile?.ownAvatarHash) {
        // The SDK establishes account ownership before accepting cached avatar results.
        restoreOwnAvatarFromCache(savedProfile.ownAvatarHash).catch(() => {})
      }
      await connecting
    } catch (err) {
      console.log('[Auth] Reconnection failed:', err instanceof Error ? err.message : err)
      clearSession()
      isResumptionRef.current = false
    }
  }, [claimConnection, i18n.language, restoreOwnAvatarFromCache, setContacts, setHttpUploadService, setOwnNickname, setServerInfo, startupConnect, updateOwnResource])

  // ── Path B: FAST token auto-connect (new tab, no sessionStorage) ──
  // When the user closed the tab, sessionStorage is lost but a FAST token
  // may persist in localStorage (valid for up to 14 days).
  // Only attempt this when the user previously opted in via "Remember Me".
  // On Tauri, the OS keychain password is loaded as a fallback: if the
  // server doesn't advertise SASL2/FAST during negotiation, xmpp.js will
  // use the password over legacy SASL instead of throwing "no credentials".
  const connectWithFastToken = useCallback(async (epoch: number, savedJid: string, effectiveServer: string) => {
    const resource = getResource()
    const serverOptions = getConnectionServerOptions(savedJid, effectiveServer)

    // Check if another tab already holds this JID (web only)
    if (claimConnection) {
      const canConnect = await claimConnection(savedJid).catch(() => true)
      if (!canConnect) {
        console.log('[Auth] Another tab already connected, skipping FAST auto-connect')
        return
      }
    }

    // On Tauri, load the keychain password as a fallback. xmpp.js will
    // prefer the FAST token when the server advertises SASL2+FAST; the
    // password is only used when FAST is unavailable. Web has no keychain
    // — the FAST-only path remains unchanged.
    let fallbackPassword: string | undefined
    if (platform().nativeKeychain && hasSavedCredentials()) {
      try {
        const creds = await getCredentials()
        if (creds && getBareJid(creds.jid) === getBareJid(savedJid)) {
          fallbackPassword = creds.password
        }
      } catch (err) {
        console.log('[Auth] Keychain fallback unavailable:', err)
      }
    }

    console.log(
      fallbackPassword
        ? '[Auth] Attempting FAST token auto-connect (keychain password as fallback)'
        : '[Auth] Attempting FAST token auto-connect (no password)'
    )

    // Auto-retry transient transport failures: FAST token auto-connect
    // after a fresh tab open faces the same wake-from-sleep network
    // flakiness as page-reload. Auth failures (bad/expired token) still
    // surface via the machine's AUTH_ERROR path and delete the token.
    try {
      await prepareNativePushAccount(savedJid)
      const connected = await startupConnect(epoch, buildStartupConnectionOptions(
        { jid: savedJid, password: fallbackPassword, ...serverOptions, resource, lang: i18n.language },
        { kind: 'fast-token' },
      ))
      // Save session for subsequent in-tab reconnects. Store the
      // fallback password so reloads (Path A) don't have to re-hit
      // the keychain; empty string preserves prior behavior when no
      // password is available.
      if (connected) saveSession(savedJid, fallbackPassword ?? '', serverOptions.server)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.log('[Auth] FAST token connect failed:', message)
      // Only delete the token on an actual auth failure. Transport or
      // "no credentials" errors (e.g. SASL2 not advertised) leave a valid
      // token in place for a future attempt.
      if (message.includes('not-authorized') || message.toLowerCase().includes('authentication')) {
        deleteFastToken(savedJid)
      }
      // Login screen shows (status reverts to error/disconnected)
    }
  }, [claimConnection, i18n.language, startupConnect])

  // ── Path C: native keychain password, no FAST token (desktop, iOS) ──
  // The sign-in the login form used to run after painting itself. Running it
  // here, before any screen is chosen, is what keeps the form off the screen;
  // the form still loads and shows the credentials if this fails.
  const connectFromKeychain = useCallback(async (epoch: number) => {
    // Let the screen paint before a keychain read that may prompt the user.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    if (startupObsolete(epoch)) return
    let credentials: Awaited<ReturnType<typeof getCredentials>> = null
    try {
      credentials = await getCredentials()
    } catch (error) {
      console.error('[Auth] Failed to load keychain credentials:', error)
    }
    const loginJid = credentials?.jid.trim()
    // Nothing usable: the login form takes over, with no attempt spent.
    if (!credentials || !loginJid || !credentials.password) return
    const serverOptions = getConnectionServerOptions(loginJid, credentials.server || '')
    // Check if another tab already holds this JID
    if (claimConnection && !(await claimConnection(loginJid))) return
    // This is the one automatic keychain attempt of this failure episode: the
    // retry on 'error' below must not spend a second one on the same password.
    keychainRetryAttempted.current = true
    // Start the Argon2id unlock (~500 ms) now so it overlaps with the XMPP
    // login round-trip instead of blocking the first encrypted send.
    void prewarmOpenpgpUnlock(loginJid)
    try {
      await prepareNativePushAccount(loginJid)
      const connected = await startupConnect(epoch, buildStartupConnectionOptions(
        { jid: loginJid, password: credentials.password, ...serverOptions, resource: getResource(), lang: i18n.language },
        { kind: 'keychain', hasNativeConnectionKeepalive: platform().hasNativeConnectionKeepalive },
      ))
      // Save session for auto-reconnect on page reload
      if (connected) saveSession(loginJid, credentials.password, serverOptions.server)
    } catch (err) {
      // Status says 'error': the login form shows it with the credentials prefilled.
      console.log('[Auth] Keychain auto-connect failed:', err instanceof Error ? err.message : String(err))
    }
  }, [claimConnection, i18n.language, startupConnect, startupObsolete])

  const runStartup = useCallback(async (epoch: number) => {
    try {
      // Links first (desktop, iOS): a login link that launched the app, or
      // that arrives while the startup is pending, replaces the saved account.
      if (platform().hasDeepLinkEvents) {
        setStartupLoginHandler((prefill) => abandonStartup(epoch, prefill))
        await ensureDeepLinkRouter()
        if (startupObsolete(epoch)) return
      }
      const session = getSession()
      if (session) {
        await reconnectFromSession(epoch, session)
        return
      }
      const standalone = standaloneStartupReconnect()
      if (standalone?.kind === 'fast-token') {
        await connectWithFastToken(epoch, standalone.jid, standalone.server)
      } else if (standalone?.kind === 'keychain') {
        await connectFromKeychain(epoch)
      }
    } catch (err) {
      console.log('[Auth] Startup reconnect did not run:', err instanceof Error ? err.message : String(err))
    } finally {
      // A startup that left no attempt in flight is over. One that did is
      // ended by the status effects below: online, a clean teardown, or an
      // error with no fallback left.
      if (connectionStore.getState().status === 'disconnected') endStartup()
    }
  }, [abandonStartup, connectFromKeychain, connectWithFastToken, endStartup, reconnectFromSession, startupObsolete])

  // Auto-reconnect on page reload
  useEffect(() => {
    // Only evaluate auto-reconnect once per app startup, and only from an
    // initial disconnected state. Without this guard, a later manual
    // disconnect can accidentally trigger an "auto-reconnect on reload".
    if (autoReconnectCheckedRef.current || status !== 'disconnected') return
    autoReconnectCheckedRef.current = true

    // Single source of truth: if the user deliberately logged out, never
    // auto-reconnect — no matter which credential (sessionStorage session,
    // FAST token or keychain password) happened to survive cleanup, and
    // regardless of the webview reload that resets the in-memory guard above.
    // The intent is persisted in localStorage so it survives that reload;
    // logout sets it synchronously before any cleanup runs. This replaces the
    // previous "delete the credential fast enough to beat the reload" race
    // with a guard that runs first. `startupPending` already folded it in.
    if (!startupPending) return
    void runStartup(startupEpochRef.current)
  }, [status, startupPending, runStartup])

  // The startup ends with the connection: online, or a clean teardown after an
  // attempt began (cancelled reconnect, logout, another tab took over, quit).
  const previousStatusRef = useRef(status)
  useEffect(() => {
    const previous = previousStatusRef.current
    previousStatusRef.current = status
    if (status === 'online' || (status === 'disconnected' && previous !== 'disconnected')) endStartup()
  }, [status, endStartup])

  // Note: Presence sync is now handled automatically by XState's native persistence
  // in XMPPProvider. The machine state is restored from sessionStorage on init.

  // Reset isResumptionRef when disconnected
  useEffect(() => {
    if (status === 'disconnected') {
      isResumptionRef.current = false
    }
  }, [status])

  // Tauri: when auth fails during a FAST-token reconnect that had no password in
  // memory (e.g. keychain was locked at startup), try reading the keychain now
  // that the user may have unlocked it. Exactly one retry per failure episode.
  //
  // The one-shot re-arms only on a *settled* connection state — 'online' after a
  // success, or 'disconnected' after a clean teardown. It must NOT re-arm on the
  // transient 'connecting'/'reconnecting'/'verifying' states, because the retry's
  // own connect() flips status to 'connecting' before landing back on 'error'.
  // Re-arming there let a genuinely wrong stored password loop forever —
  // error -> connecting -> error, re-firing the retry each cycle (issue #995).
  //
  // This retry is the startup's one permitted fallback: while it runs the
  // startup stays pending, and an error with no retry left is the startup's
  // real failure, which the login form then shows.
  useEffect(() => {
    if (status !== 'error') {
      if (status === 'online' || status === 'disconnected') {
        keychainRetryAttempted.current = false
      }
      return
    }
    const savedJid = localStorage.getItem('xmpp-last-jid')
    const savedServer = localStorage.getItem('xmpp-last-server')
    if (!platform().nativeKeychain || !hasSavedCredentials() || keychainRetryAttempted.current || !savedJid) {
      endStartup()
      return
    }

    keychainRetryAttempted.current = true
    const epoch = startupEpochRef.current
    const effectiveServer = savedServer || getDomain(savedJid)
    const serverOptions = getConnectionServerOptions(savedJid, effectiveServer)

    const retryWithKeychain = async () => {
      try {
        const creds = await getCredentials()
        if (!creds || getBareJid(creds.jid) !== getBareJid(savedJid)) {
          endStartup()
          return
        }
        console.log('[Auth] Auth failure on Tauri: retrying with keychain credentials')
        const resource = getResource()
        await prepareNativePushAccount(savedJid)
        const connected = await startupConnect(epoch, buildStartupConnectionOptions(
          { jid: savedJid, password: creds.password, ...serverOptions, resource, lang: i18n.language },
          { kind: 'keychain-retry' },
        ))
        if (connected) saveSession(savedJid, creds.password, serverOptions.server)
      } catch (err) {
        console.log('[Auth] Keychain retry after auth failure failed:', err instanceof Error ? err.message : err)
        // A failed retry lands on 'error' again, where this effect finds the
        // attempt spent; anything else that failed here ends the startup too.
        if (connectionStore.getState().status !== 'connecting') endStartup()
      }
    }

    void retryWithKeychain()
  }, [status, i18n.language, endStartup, startupConnect])

  return { startupPending }

  // Persistence of SM-resumable state (rooms, roster, server info, own
  // profile, own resources) is handled inside the SDK via StateSnapshot:
  // it subscribes to each store, writes through to StorageAdapter with a
  // 500ms debounce, and flushes on beforeunload via XMPPProvider.
  //
  // Presence state is saved automatically by XState's native persistence
  // in XMPPProvider (key: 'fluux:presence-machine').
}
