import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useConnection } from '@fluux/sdk'
import { Loader2, KeyRound, Eye, EyeOff } from 'lucide-react'
import { saveSession } from '@/hooks/useSessionPersistence'
import { getResource } from '@/utils/xmppResource'
import { hasSavedCredentials, getCredentials, saveCredentials, deleteCredentials } from '@/utils/keychain'
import { isTauri } from '@/utils/tauri'
import { getDomainFromJid, getWebsocketUrlForDomain } from '@/config/wellKnownServers'
import { useWindowDrag } from '@/hooks'

const STORAGE_KEY_JID = 'xmpp-last-jid'
const STORAGE_KEY_SERVER = 'xmpp-last-server'
const STORAGE_KEY_REMEMBER = 'xmpp-remember-me'

export function LoginScreen() {
  const { t, i18n } = useTranslation()
  const { status, error, connect } = useConnection()
  const { dragRegionProps } = useWindowDrag()

  const [jid, setJid] = useState('')
  const [password, setPassword] = useState('')
  const [server, setServer] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const passwordInputRef = useRef<HTMLInputElement>(null)
  const [loadedFromKeychain, setLoadedFromKeychain] = useState(false)
  const [credentialsModified, setCredentialsModified] = useState(false)
  const [isDesktopApp, setIsDesktopApp] = useState(false)
  const [isLoadingCredentials, setIsLoadingCredentials] = useState(true)

  // Prevent double-execution in React StrictMode
  const hasLoadedCredentials = useRef(false)
  const hasAutoConnected = useRef(false)

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
      if (savedServer) setServer(savedServer)

      // Try to load credentials from keychain (Tauri only)
      // Only check keychain if we previously saved credentials (avoids prompt on first run)
      if (inTauri && hasSavedCredentials()) {
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

    loadCredentials()
  }, [])

  // Auto-fill WebSocket URL for well-known servers when JID domain changes (web only)
  // Desktop app uses TCP proxy with SRV resolution, so WebSocket URLs are not needed
  // Track if user has manually interacted with server field to prevent auto-fill after user clears it
  const [hasManuallySetServer, setHasManuallySetServer] = useState(false)

  useEffect(() => {
    if (isDesktopApp) return // Skip auto-fill for desktop - TCP proxy handles this
    if (hasManuallySetServer) return // Don't auto-fill if user has manually set/cleared the field
    if (server) return // Don't override if server field already has a value
    if (isLoadingCredentials) return // Wait for credentials to load first

    const domain = getDomainFromJid(jid)
    if (domain) {
      const websocketUrl = getWebsocketUrlForDomain(domain)
      if (websocketUrl) {
        setServer(websocketUrl)
      }
    }
  }, [jid, server, isLoadingCredentials, isDesktopApp, hasManuallySetServer])

  // Handle authentication errors
  useEffect(() => {
    if (!error) return

    // Delete keychain credentials on "not-authorized" error (invalid password)
    if (loadedFromKeychain && isDesktopApp && error.includes('not-authorized')) {
      console.log('[LoginScreen] Deleting keychain credentials after auth failure')
      deleteCredentials()
      setLoadedFromKeychain(false)
    }
  }, [error, loadedFromKeychain, isDesktopApp])


  // Auto-connect when credentials are loaded from keychain
  useEffect(() => {
    // Only auto-connect once, when credentials are loaded from keychain
    if (hasAutoConnected.current) return
    if (isLoadingCredentials) return
    if (!loadedFromKeychain) return
    if (!jid || !password) return
    if (status === 'connecting' || status === 'online') return

    // Mark as auto-connected to prevent loops
    hasAutoConnected.current = true

    // Trigger connection with keychain credentials
    const autoConnect = async () => {
      const actualServer = server || jid.split('@')[1]
      try {
        const resource = getResource()
        await connect(jid, password, actualServer, undefined, resource, i18n.language, isTauri())
        // Save session for auto-reconnect on page reload
        saveSession(jid, password, actualServer)
      } catch {
        // Error is handled in hook
        // Don't reset hasAutoConnected - user must click Connect to retry
      }
    }

    autoConnect()
  }, [isLoadingCredentials, loadedFromKeychain, jid, password, server, status, connect, i18n.language])

  const isConnecting = status === 'connecting'
  const isLoading = isLoadingCredentials || isConnecting

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Default server from JID domain if not specified
    const actualServer = server || jid.split('@')[1]

    // Save JID and server for next time
    localStorage.setItem(STORAGE_KEY_JID, jid)
    localStorage.setItem(STORAGE_KEY_SERVER, server)

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

    try {
      const resource = getResource()
      await connect(jid, password, actualServer, undefined, resource, i18n.language, isTauri())
      // Save session for auto-reconnect on page reload
      saveSession(jid, password, actualServer)

      // Save to keychain immediately after successful connect (before component unmounts)
      if (shouldSaveToKeychain) {
        try {
          await saveCredentials(jid, password, server || null)
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
    <div className="h-full bg-fluux-bg flex items-center justify-center p-4 relative">
      {/* Window drag region - covers top area for title bar */}
      <div className="absolute top-0 left-0 right-0 h-8" {...dragRegionProps} />
      <div className="w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <img
            src="/logo.png"
            alt={t('login.title')}
            className="w-16 h-16 mx-auto mb-4"
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
            <input
              id="jid"
              name="username"
              type="text"
              autoComplete="username"
              value={jid}
              onChange={(e) => { setJid(e.target.value); setCredentialsModified(true) }}
              placeholder={t('login.jidPlaceholder')}
              required
              disabled={isLoading}
              className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                         border border-fluux-border focus:border-fluux-brand
                         focus-visible:ring-2 focus-visible:ring-fluux-brand/50
                         placeholder:text-fluux-muted disabled:opacity-50"
            />
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
                className="w-full px-3 py-2 pr-10 bg-fluux-bg text-fluux-text rounded
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
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fluux-muted hover:text-fluux-text
                           disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
              >
                {showPassword ? (
                  <EyeOff className="w-5 h-5" />
                ) : (
                  <Eye className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>

          {/* Server Field (Optional) */}
          <div>
            <label htmlFor="server" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
              {t('login.serverLabel')}
            </label>
            <input
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
          </div>

          {/* Remember Me (Desktop app only) */}
          {isDesktopApp && (
            <div className="flex items-center gap-3">
              <input
                id="remember"
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={isLoading}
                className="w-4 h-4 rounded border border-fluux-border bg-fluux-bg
                           checked:bg-fluux-brand checked:border-fluux-brand
                           focus:ring-fluux-brand focus:ring-offset-0"
              />
              <label htmlFor="remember" className="text-sm text-fluux-text flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-fluux-muted" />
                {t('login.rememberMe')}
                <span className="text-xs text-fluux-muted">{t('login.storedInKeychain')}</span>
              </label>
            </div>
          )}

          {/* Keychain indicator */}
          {loadedFromKeychain && (
            <div className="flex items-center gap-2 text-xs text-fluux-green">
              <KeyRound className="w-3 h-3" />
              {t('login.credentialsLoaded')}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-fluux-red/20 border border-fluux-red/50 rounded text-fluux-red text-sm">
              {error}
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isLoading || !jid || !password}
            className="w-full py-2.5 bg-fluux-brand hover:bg-fluux-brand-hover
                       text-white font-medium rounded transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed
                       focus-visible:ring-2 focus-visible:ring-fluux-brand focus-visible:ring-offset-2 focus-visible:ring-offset-fluux-sidebar
                       flex items-center justify-center gap-2"
          >
            {isConnecting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('login.connecting')}
              </>
            ) : (
              t('login.connect')
            )}
          </button>
        </form>

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
  )
}
