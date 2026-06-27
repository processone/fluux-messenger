import React, { useState, useEffect, useRef } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { useConnectionStatus, useConnectionActions, deleteFastToken, classifyConnectionError } from '@fluux/sdk'
import { Loader2, KeyRound, Eye, EyeOff, ChevronDown, ChevronRight } from 'lucide-react'
import { saveSession } from '@/hooks/useSessionPersistence'
import { getResource } from '@/utils/xmppResource'
import { hasSavedCredentials, getCredentials, saveCredentials, deleteCredentials } from '@/utils/keychain'
import { isTauri } from '@/utils/tauri'
import { getDomainFromJid, getWebsocketUrlForDomain } from '@/config/wellKnownServers'
import { useWindowDrag } from '@/hooks'
import { isOpenpgpEnabled } from '@/stores/encryptionSettingsStore'
import { getReconnectIntent } from '@/utils/reconnectIntent'
import { validateBareJid } from '@/utils/jidValidation'
import { LoginErrorPanel } from './LoginErrorPanel'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'
import { useLoginPrefillStore } from '@/stores/loginPrefillStore'
import { useLoginPrefillDeepLink } from '@/hooks/useLoginPrefillDeepLink'

const STORAGE_KEY_JID = 'xmpp-last-jid'
const STORAGE_KEY_SERVER = 'xmpp-last-server'
const STORAGE_KEY_REMEMBER = 'xmpp-remember-me'

/**
 * Kick off the Argon2id secret-key unlock on the Rust side so the KDF
 * runs in parallel with the XMPP login handshake. No-op on web and
 * when encryption is disabled; fire-and-forget in every other case —
 * the Rust command spawns a background task and returns immediately.
 *
 * If this errors we fall back to the lazy path: `SequoiaPgpPlugin.init`
 * on the `online` event will run the unlock itself (the same KDF, just
 * with visible latency). So we log and move on; never block the user.
 */
async function prewarmOpenpgpUnlock(jid: string): Promise<void> {
  if (!isTauri()) return
  if (!isOpenpgpEnabled()) return
  const bareJid = jid.split('/')[0]
  if (!bareJid || !bareJid.includes('@')) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('openpgp_prewarm', {
      accountJid: bareJid,
      // user_id doubles as the OpenPGP User ID when a fresh key is
      // generated; the JID is the right value for both historically
      // (mirrors SequoiaPgpPlugin.ensureIdentity's arguments).
      userId: `xmpp:${bareJid}`,
    })
  } catch (err) {
    console.warn('[Fluux] openpgp_prewarm failed (will unlock lazily):', err)
  }
}

/**
 * Resolve the connection target with explicit priority:
 * 1. User-provided server value
 * 2. Well-known WebSocket endpoint for the JID domain
 * 3. Raw JID domain (for XEP-0156 / proxy fallback paths)
 */
function resolveServerForConnection(jid: string, server: string): string {
  if (server) return server
  const domain = getDomainFromJid(jid) || jid.split('@')[1] || ''
  if (!domain) return ''
  return getWebsocketUrlForDomain(domain) || domain
}

interface LoginScreenProps {
  /** Tab coordination: checks if another tab already holds this JID */
  claimConnection?: (jid: string) => Promise<boolean>
}

export function LoginScreen({ claimConnection }: LoginScreenProps) {
  detectRenderLoop('LoginScreen')
  const { t, i18n } = useTranslation()
  const { status, error } = useConnectionStatus()
  const { connect } = useConnectionActions()
  const { dragRegionProps } = useWindowDrag()

  // Workaround: On macOS, the WRY/WKWebView can lose native event delivery
  // after large DOM changes (ChatLayout → LoginScreen). When this happens,
  // the webview renders and runs JS, but mouse/keyboard events don't arrive —
  // even Cmd+Opt+I (DevTools) stops working.
  //
  // The only reliable fix is to reload the webview, which resets WRY's native
  // event pipeline. We detect post-disconnect transitions via a sessionStorage
  // flag (set by App.tsx when status='online'). The key uses a '__wry_' prefix
  // so it survives clearLocalData() which only removes 'fluux:' prefixed keys.
  // After reload, the flag is gone (cleared here before reload) → no loop.
  // See: https://github.com/tauri-apps/wry/issues/184
  useEffect(() => {
    if (!isTauri()) return
    const flag = sessionStorage.getItem('__wry_was_online')
    if (!flag) return

    // Clear the flag before reload to prevent infinite reload loop.
    sessionStorage.removeItem('__wry_was_online')
    console.log('[Fluux] Reloading webview to restore native event delivery after disconnect')
    window.location.reload()
  }, [])

  const [jid, setJid] = useState('')
  // Whether the JID field has been blurred at least once — only then do we show
  // the malformed-shape hint, so the user isn't nagged mid-typing.
  const [jidTouched, setJidTouched] = useState(false)
  const [password, setPassword] = useState('')
  const [server, setServer] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showServerField, setShowServerField] = useState(false)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const [loadedFromKeychain, setLoadedFromKeychain] = useState(false)
  const [credentialsModified, setCredentialsModified] = useState(false)
  const [isDesktopApp, setIsDesktopApp] = useState(false)
  const [isLoadingCredentials, setIsLoadingCredentials] = useState(true)

  // Prevent double-execution in React StrictMode
  const hasLoadedCredentials = useRef(false)
  const hasAutoConnected = useRef(false)

  // Advanced mode: a discreet opt-in checkbox below the form unlocks the
  // advanced settings category (and, later, advanced login options).
  const advancedMode = useAdvancedModeStore((s) => s.advancedMode)
  const setAdvancedMode = useAdvancedModeStore((s) => s.setAdvancedMode)

  // Login prefill from an xmpp: deep link (desktop) or URL params (web).
  useLoginPrefillDeepLink()
  const prefill = useLoginPrefillStore((s) => s.prefill)
  const clearPrefill = useLoginPrefillStore((s) => s.clearPrefill)
  // Host of a link-supplied custom server, shown as a calm note under the field.
  const [linkServerHost, setLinkServerHost] = useState<string | null>(null)
  // A link-supplied resource overrides getResource() at submit time.
  const linkResourceRef = useRef<string | undefined>(undefined)

  // Check if running in Tauri and load credentials
  useEffect(() => {
    // Skip if already loaded (StrictMode protection)
    if (hasLoadedCredentials.current) {
      setIsLoadingCredentials(false)
      return
    }
    hasLoadedCredentials.current = true

    const loadCredentials = async () => {
      // Check if we're in Tauri
      const inTauri = isTauri()
      setIsDesktopApp(inTauri)

      // Load remember me preference
      const savedRemember = localStorage.getItem(STORAGE_KEY_REMEMBER)
      if (savedRemember === 'true') {
        setRememberMe(true)
      }

      // Load JID and server from localStorage first (fast, no prompt)
      const savedJid = localStorage.getItem(STORAGE_KEY_JID)
      const savedServer = localStorage.getItem(STORAGE_KEY_SERVER)
      if (savedJid) setJid(savedJid)
      // On web, ignore bare-domain server values (e.g. from desktop sessions)
      // so well-known auto-fill can provide the correct WebSocket URL
      const isWebSocketUrl = savedServer?.startsWith('ws://') || savedServer?.startsWith('wss://')
      if (savedServer && (inTauri || isWebSocketUrl)) {
        setServer(savedServer)
      }

      // Try to load credentials from keychain (Tauri only)
      // Only check keychain if we previously saved credentials (avoids prompt on first run)
      // A link prefill represents explicit intent for a (possibly different)
      // account, so do not auto-load / auto-connect saved keychain credentials.
      const hasLinkPrefill = !!useLoginPrefillStore.getState().prefill
      if (inTauri && hasSavedCredentials() && !hasLinkPrefill) {
        // Wait for browser to paint the login screen before triggering keychain prompt
        // Double requestAnimationFrame ensures the paint has completed
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

        const credentials = await getCredentials()
        if (credentials) {
          setJid(credentials.jid)
          setPassword(credentials.password)
          setServer(credentials.server || '')
          setLoadedFromKeychain(true)
          setRememberMe(true)
          setIsLoadingCredentials(false)
          return
        }
      }

      setIsLoadingCredentials(false)
    }

    void loadCredentials().catch((error) => {
      console.error('[LoginScreen] Failed to load credentials:', error)
      setIsLoadingCredentials(false)
    })
  }, [])

  // Auto-fill WebSocket URL for well-known servers when JID domain changes (web only).
  // Desktop keeps the field untouched, but submit-time resolution still prefers
  // known WebSocket URLs before falling back to domain/proxy flow.
  // Track if user has manually interacted with server field to prevent auto-fill after user clears it
  const [hasManuallySetServer, setHasManuallySetServer] = useState(false)

  useEffect(() => {
    if (isDesktopApp) return // Skip auto-fill for desktop - TCP proxy handles this
    if (hasManuallySetServer) return // Don't auto-fill if user has manually set/cleared the field
    if (isLoadingCredentials) return // Wait for credentials to load first
    // Only skip auto-fill if server is already a WebSocket URL
    // A bare domain (from desktop/previous session) should be overridable
    if (server.startsWith('ws://') || server.startsWith('wss://')) return

    const domain = getDomainFromJid(jid)
    if (domain) {
      const websocketUrl = getWebsocketUrlForDomain(domain)
      if (websocketUrl) {
        setServer(websocketUrl)
      }
    }
  }, [jid, server, isLoadingCredentials, isDesktopApp, hasManuallySetServer])

  // Show server field if a saved server value was loaded
  useEffect(() => {
    if (!isLoadingCredentials && server) {
      setShowServerField(true)
    }
  }, [isLoadingCredentials, server])

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

  // Handle authentication errors + auto-reveal server field on non-auth errors
  useEffect(() => {
    if (!error) return

    // Delete keychain credentials on "not-authorized" error (invalid password)
    if (loadedFromKeychain && isDesktopApp && error.includes('not-authorized')) {
      console.log('[LoginScreen] Deleting keychain credentials after auth failure')
      void deleteCredentials().catch((err) => {
        console.error('[LoginScreen] Failed to delete keychain credentials:', err)
      })
      setLoadedFromKeychain(false)
    }

    // Clear FAST token on auth failure (web) — prevents stale token from
    // triggering auto-connect loops on next tab open
    if (classifyConnectionError(error) === 'auth') {
      const savedJid = localStorage.getItem(STORAGE_KEY_JID)
      if (savedJid) {
        deleteFastToken(savedJid)
      }
    }

    // Reveal server field on connection errors that aren't auth failures,
    // so the user can manually specify a server address
    if (classifyConnectionError(error) !== 'auth') {
      setShowServerField(true)
    }
  }, [error, loadedFromKeychain, isDesktopApp])

  // Keyboard shortcut: Cmd+, (Mac) / Ctrl+, (other) toggles server field
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setShowServerField(prev => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])


  // Auto-connect when credentials are loaded from keychain
  useEffect(() => {
    // Only auto-connect once, when credentials are loaded from keychain
    if (hasAutoConnected.current) return
    if (isLoadingCredentials) return
    if (!loadedFromKeychain) return
    if (!jid || !password) return
    if (status === 'connecting' || status === 'online') return
    // Respect a deliberate logout: never silently re-authenticate from the
    // keychain after the user logged out, even if credential deletion lost its
    // race and the keychain entry survived. Mirrors the gate in
    // useSessionPersistence — the reconnect intent is the single source of truth.
    if (getReconnectIntent() === 'logged-out') return

    // Mark as auto-connected to prevent loops
    hasAutoConnected.current = true

    // Trigger connection with keychain credentials
    const autoConnect = async () => {
      const actualServer = resolveServerForConnection(jid, server)
      try {
        // Check if another tab already holds this JID
        if (claimConnection && !(await claimConnection(jid))) return
        // Start the Argon2id unlock (~500 ms) now so it overlaps with
        // the XMPP login round-trip instead of blocking the user's
        // first fingerprint / encrypted send after `online`.
        void prewarmOpenpgpUnlock(jid)
        const resource = getResource()
        await connect(jid, password, actualServer, undefined, resource, i18n.language, isTauri(), true)
        // Save session for auto-reconnect on page reload
        saveSession(jid, password, actualServer)
      } catch {
        // Error is handled in hook
        // Don't reset hasAutoConnected - user must click Connect to retry
      }
    }

    void autoConnect()
  }, [isLoadingCredentials, loadedFromKeychain, jid, password, server, status, connect, i18n.language, claimConnection])

  const isConnecting = status === 'connecting'
  const isLoading = isLoadingCredentials || isConnecting

  // Local JID shape validation (UX_REVIEW §1.4) — gates Connect and shows
  // inline help on a malformed shape, before any network round-trip.
  const jidValidation = validateBareJid(jid)
  const showJidError = jidTouched && !jidValidation.valid && jidValidation.reason === 'malformed'

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const actualServer = resolveServerForConnection(jid, server)

    // Save JID and server for next time
    // Store the resolved server (not the raw input) so FAST token auto-reconnect
    // can use it even when the server field was left empty (hidden by default).
    localStorage.setItem(STORAGE_KEY_JID, jid)
    localStorage.setItem(STORAGE_KEY_SERVER, actualServer || server)

    // Save remember me preference
    localStorage.setItem(STORAGE_KEY_REMEMBER, rememberMe ? 'true' : 'false')

    // Handle keychain storage (Tauri only)
    // Use local variable since React state updates are async
    const shouldSaveToKeychain = isDesktopApp && rememberMe && (!loadedFromKeychain || credentialsModified)

    if (isDesktopApp) {
      if (!rememberMe && loadedFromKeychain) {
        // User unchecked "Remember me" - delete stored credentials
        try {
          await deleteCredentials()
          setLoadedFromKeychain(false)
        } catch (err) {
          console.error('Failed to delete credentials from keychain:', err)
        }
      }
    }

    // Delete FAST token when user opts out of "Remember Me"
    if (!rememberMe && jid) {
      deleteFastToken(jid)
    }

    try {
      // Check if another tab already holds this JID
      if (claimConnection && !(await claimConnection(jid))) return
      // Kick off the Argon2id unlock before the socket connects so the
      // KDF (~500 ms) overlaps with the TCP/TLS/XMPP handshake.
      void prewarmOpenpgpUnlock(jid)
      const resource = linkResourceRef.current || getResource()
      await connect(jid, password, actualServer, undefined, resource, i18n.language, isTauri(), rememberMe)
      // Save session for auto-reconnect on page reload
      saveSession(jid, password, actualServer)

      // Save to keychain immediately after successful connect (before component unmounts)
      if (shouldSaveToKeychain) {
        try {
          await saveCredentials(jid, password, actualServer || null)
          setLoadedFromKeychain(true)
        } catch (err) {
          console.error('Failed to save credentials to keychain:', err)
        }
      }
    } catch {
      // Error is handled in hook
    }
  }

  return (
    <div className="h-full bg-fluux-bg overflow-y-auto relative">
      {/* Window drag region - covers top area for title bar */}
      <div className="absolute top-0 inset-x-0 h-8" {...dragRegionProps} />
      {/* min-h-full + centering keeps the card centered when there is room, but
          lets the container scroll to every field on short viewports (e.g. a
          phone in landscape with the keyboard open). */}
      <div className="min-h-full flex items-center justify-center p-4">
        <div className="w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <img
            src="/logo.png"
            alt={t('login.title')}
            className="size-16 mx-auto mb-4"
          />
          <h1 className="text-2xl font-bold text-fluux-text">{t('login.title')}</h1>
          <p className="text-fluux-muted mt-2">{t('login.subtitle')}</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} name="login" className="bg-fluux-sidebar rounded-lg p-6 space-y-4">
          {/* JID Field */}
          <div>
            <label htmlFor="jid" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              {t('login.jidLabel')}
            </label>
            <TextInput
              id="jid"
              name="username"
              type="text"
              autoComplete="username"
              value={jid}
              onChange={(e) => { setJid(e.target.value); setCredentialsModified(true) }}
              onBlur={() => setJidTouched(true)}
              placeholder={t('login.jidPlaceholder')}
              required
              disabled={isLoading}
              aria-invalid={showJidError}
              aria-describedby={showJidError ? 'jid-error' : undefined}
              className={`w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border focus:border-fluux-brand
                         focus-visible:ring-2 focus-visible:ring-fluux-brand/50
                         placeholder:text-fluux-muted disabled:opacity-50
                         ${showJidError ? 'border-fluux-red' : 'border-fluux-border'}`}
            />
            {showJidError && (
              <p id="jid-error" className="text-xs text-fluux-error mt-1">
                {t('login.jidInvalid')}
              </p>
            )}
          </div>

          {/* Password Field */}
          <div>
            <label htmlFor="password" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              {t('login.passwordLabel')}
            </label>
            <div className="relative">
              <input
                ref={passwordInputRef}
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setCredentialsModified(true) }}
                required
                disabled={isLoading}
                className="w-full px-3 py-2 pe-10 bg-fluux-bg text-fluux-text rounded
                           border border-fluux-border focus:border-fluux-brand
                           focus-visible:ring-2 focus-visible:ring-fluux-brand/50
                           placeholder:text-fluux-muted disabled:opacity-50"
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => {
                  setShowPassword(!showPassword)
                  // Keep focus on the password input after toggling
                  passwordInputRef.current?.focus()
                }}
                disabled={isLoading}
                className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-fluux-muted hover:text-fluux-text
                           disabled:opacity-50 disabled:cursor-not-allowed transition-colors tap-target"
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
              >
                {showPassword ? (
                  <EyeOff className="size-5" />
                ) : (
                  <Eye className="size-5" />
                )}
              </button>
            </div>
          </div>

          {/* Server Field (Advanced - hidden by default) */}
          <div>
            <button
              type="button"
              onClick={() => setShowServerField(!showServerField)}
              className="flex items-center gap-1 text-xs text-fluux-muted hover:text-fluux-text transition-colors mb-2"
            >
              {showServerField ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              <span className="font-semibold uppercase">{t('login.serverLabel')}</span>
            </button>
            {showServerField && (
              <>
                <TextInput
                  id="server"
                  type="text"
                  value={server}
                  onChange={(e) => {
                    setServer(e.target.value)
                    setCredentialsModified(true)
                    setHasManuallySetServer(true) // Prevent auto-fill after manual edit
                  }}
                  placeholder={isDesktopApp ? t('login.serverPlaceholderDesktop') : t('login.serverPlaceholder')}
                  disabled={isLoading}
                  className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                             border border-fluux-border focus:border-fluux-brand
                             focus-visible:ring-2 focus-visible:ring-fluux-brand/50
                             placeholder:text-fluux-muted disabled:opacity-50"
                />
                <p className="text-xs text-fluux-muted mt-1">
                  {isDesktopApp ? t('login.serverHintDesktop') : t('login.serverHint')}
                </p>
                {linkServerHost && (
                  <p className="text-xs text-fluux-muted mt-1">
                    {t('login.linkSetServer', { host: linkServerHost })}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Remember Me */}
          <div className="flex items-center gap-3">
            <input
              id="remember"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              disabled={isLoading}
              className="size-4 rounded border border-fluux-border bg-fluux-bg
                         checked:bg-fluux-brand checked:border-fluux-brand
                         focus:ring-fluux-brand focus:ring-offset-0"
            />
            <label htmlFor="remember" className="text-sm text-fluux-text flex items-center gap-2">
              <KeyRound className="size-4 text-fluux-muted" />
              {t('login.rememberMe')}
              {isDesktopApp && (
                <span className="text-xs text-fluux-muted">{t('login.storedInKeychain')}</span>
              )}
              {!isDesktopApp && (
                <span className="text-xs text-fluux-muted">{t('login.staySignedIn')}</span>
              )}
            </label>
          </div>

          {/* Keychain indicator */}
          {loadedFromKeychain && (
            <div className="flex items-center gap-2 text-xs text-fluux-green">
              <KeyRound className="size-3" />
              {t('login.credentialsLoaded')}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <LoginErrorPanel kind={classifyConnectionError(error)} rawError={error} />
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isLoading || !jidValidation.valid || !password}
            className="w-full py-2.5 bg-fluux-brand hover:bg-fluux-brand-hover
                       text-fluux-text-on-accent font-medium rounded transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed
                       focus-visible:ring-2 focus-visible:ring-fluux-brand focus-visible:ring-offset-2 focus-visible:ring-offset-fluux-sidebar
                       flex items-center justify-center gap-2"
          >
            {isConnecting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('login.connecting')}
              </>
            ) : (
              t('login.connect')
            )}
          </button>
        </form>

        {/* Advanced mode toggle - discreet opt-in below the form. Reveals the
            advanced settings category (and, later, advanced login options). */}
        <div className="flex items-center justify-center gap-2 mt-4">
          <input
            id="advanced-mode"
            type="checkbox"
            checked={advancedMode}
            onChange={(e) => setAdvancedMode(e.target.checked)}
            className="size-3.5 rounded border border-fluux-border bg-fluux-bg
                       checked:bg-fluux-brand checked:border-fluux-brand
                       focus:ring-fluux-brand focus:ring-offset-0"
          />
          <label htmlFor="advanced-mode" className="text-xs text-fluux-muted select-none">
            {t('login.advancedMode')}
          </label>
        </div>

        {/* Footer */}
        <div className="text-center text-fluux-muted text-sm mt-6 space-y-1">
          <p>
            {t('login.madeBy')}{' '}
            <a
              href="https://www.process-one.net"
              target="_blank"
              rel="noopener noreferrer"
              className="text-fluux-brand hover:underline"
            >
              ProcessOne
            </a>
            {t('login.ejabberdCreator')}{' '}
            <a
              href="https://www.ejabberd.im"
              target="_blank"
              rel="noopener noreferrer"
              className="text-fluux-brand hover:underline"
            >
              ejabberd
            </a>
          </p>
          <p>
            {t('login.poweredBy')}{' '}
            <a
              href="https://xmpp.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-fluux-brand hover:underline"
            >
              XMPP
            </a>
          </p>
        </div>
        </div>
      </div>
    </div>
  )
}
