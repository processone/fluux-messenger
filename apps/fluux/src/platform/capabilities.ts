/**
 * What this build of Fluux can do, as a value rather than a runtime probe.
 *
 * Asking `isTauri()` at each decision point reads as one
 * question but is at least six: whether there is an OS keychain, whether links
 * open in the system browser, whether the window can ask for attention. Some
 * answers already diverge — in-app updates are desktop-except-Linux, the tray
 * preference is desktop-on-Windows-and-Linux, taskbar attention is
 * desktop-on-Windows-only — so the codebase already carries a capability model,
 * spelled as boolean algebra over `isTauri()`, `isWindows()` and `isLinux()` at
 * every site that needs one.
 *
 * Naming the capabilities puts that model in one place. A call site says WHY it
 * branches, so a reader can tell what a new target would have to provide, and a
 * test can grant one capability without pretending to be a whole platform.
 *
 * Add a member when a call site asks a question none of the existing ones
 * answers. Do not add a member that just means "is desktop" — that is
 * {@link PlatformCapabilities.shell}, and reaching for it is the signal that
 * the branch has not been understood yet.
 *
 * @packageDocumentation
 * @module Platform
 */

/** Which shell the UI is running inside. */
export type PlatformShell = 'desktop' | 'web'

/** Host operating system, as far as the shell can tell. */
export type PlatformOS = 'macos' | 'windows' | 'linux' | 'other'

export interface PlatformCapabilities {
  readonly shell: PlatformShell
  readonly os: PlatformOS

  /** Credentials live in the OS keychain instead of browser storage. */
  readonly nativeKeychain: boolean
  /** Attachments are saved through a native file dialog, not a download link. */
  readonly nativeDownloads: boolean
  /** Media is cached on the filesystem instead of in CacheStorage. */
  readonly nativeMediaCache: boolean
  /** Images can be read from the system clipboard through the OS. */
  readonly nativeClipboardImages: boolean
  /** Files can be dropped onto the window through the OS, not the DOM. */
  readonly nativeFileDrop: boolean
  /** Notification icons must be file paths rather than blob URLs. */
  readonly notificationsNeedFileUrls: boolean
  /** External links are handed to the system browser rather than a new tab. */
  readonly opensLinksInSystemBrowser: boolean
  /** In-app link clicks must be intercepted before the webview navigates. */
  readonly interceptsInAppNavigation: boolean
  /** HTTP requests can bypass CORS through the native side. */
  readonly nativeHttpFetch: boolean
  /** The window can ask the OS for the user's attention. */
  readonly canRequestWindowAttention: boolean
  /** Closing the window can be redirected to a system tray. */
  readonly canKeepInSystemTray: boolean
  /** The app updates itself rather than through a package manager or store. */
  readonly hasInAppUpdates: boolean
  /**
   * Storage survives without asking the browser to keep it.
   *
   * False on web, where the origin can be evicted under storage pressure and
   * the app must request persistence.
   */
  readonly storageIsDurable: boolean
  /**
   * The install has one stable identity across restarts.
   *
   * True on desktop, where a single app instance owns its XMPP resource. On
   * web every tab is an independent client, so the resource is per-session.
   */
  readonly hasStableInstallIdentity: boolean

  // ----- Encryption -----

  /**
   * The secret key sits in browser storage and a passphrase unlocks it for the
   * session, rather than living in the OS keychain.
   *
   * Drives the unlock prompt, the remember-passphrase choice, and the
   * "locked" state the settings pane shows.
   */
  readonly keyNeedsSessionPassphrase: boolean
  /**
   * Key rotation is offered.
   *
   * Tracks the plugin behind the shell rather than the host itself: the web
   * build runs openpgp.js v6, whose rotation is deferred. Move this off the
   * platform record once the two plugins agree.
   */
  readonly supportsKeyRotation: boolean

  // ----- Notifications -----

  /**
   * Notification permission is granted and revoked through the OS, so the app
   * reads it from the system and can send the user to the OS settings pane —
   * rather than requesting it in-page.
   */
  readonly notificationsManagedByOS: boolean
  /** Push arrives over Web Push rather than the OS notification centre. */
  readonly usesWebPush: boolean

  // ----- Window and process -----

  /**
   * The app draws its own title bar and must reserve room for the window
   * controls. macOS only: Windows and Linux keep a native title bar.
   */
  readonly hasCustomTitleBar: boolean
  /** The app is launched from a command line and can be passed flags. */
  readonly hasCommandLineFlags: boolean
  /** Diagnostic logs are written to files the user can open. */
  readonly hasNativeLogFiles: boolean
  /**
   * Several instances can share one storage origin, so they must agree on
   * which of them owns the session.
   *
   * True on web, where every tab is an instance.
   */
  readonly needsTabCoordination: boolean

  // ----- Connection -----

  /**
   * Keepalive is driven outside the JS event loop, so the SDK's own Stream
   * Management interval would be redundant — and, unlike the native timer, is
   * subject to background throttling.
   */
  readonly hasNativeConnectionKeepalive: boolean
  /**
   * The webview must be reloaded before a second login in the same process.
   *
   * A WebKit/wry limitation: a websocket opened after a prior session's
   * teardown does not connect until the context is recreated
   * (tauri-apps/wry#184).
   */
  readonly needsWebviewReloadBeforeRelogin: boolean
  /**
   * The webview can come back from a long machine sleep with a dead socket and
   * stalled timers, so a wake past a threshold is recovered by reloading.
   */
  readonly webviewStallsAfterSleep: boolean

  // ----- Shell integration -----

  /** The OS reports how long the user has been idle. */
  readonly hasOSIdleDetection: boolean
  /** Deep links arrive as shell events rather than as a page load. */
  readonly hasDeepLinkEvents: boolean
  /** Window fullscreen state is owned by the shell, not the Fullscreen API. */
  readonly hasWindowFullscreenEvents: boolean
  /** The shell draws a title bar that follows the app's light/dark theme. */
  readonly syncsNativeTitleBarTheme: boolean
  /** The unread count goes on a dock or taskbar badge. */
  readonly hasNativeAppBadge: boolean
  /** A native context menu opens on right-click unless suppressed. */
  readonly hasNativeContextMenu: boolean
  /** Uploads are streamed by the native side rather than by fetch. */
  readonly nativeUploads: boolean
  /** The local MCP bridge server can run. */
  readonly hasMcpBridge: boolean
}

/**
 * Derive the capability record from a shell and an OS.
 *
 * Pure, so a test can build any combination — including ones no real host
 * produces — without touching globals.
 */
export function deriveCapabilities(shell: PlatformShell, os: PlatformOS): PlatformCapabilities {
  const desktop = shell === 'desktop'
  return {
    shell,
    os,
    nativeKeychain: desktop,
    nativeDownloads: desktop,
    nativeMediaCache: desktop,
    nativeClipboardImages: desktop,
    nativeFileDrop: desktop,
    notificationsNeedFileUrls: desktop,
    opensLinksInSystemBrowser: desktop,
    interceptsInAppNavigation: desktop,
    nativeHttpFetch: desktop,
    // Windows is the only host with a taskbar attention request behind it.
    canRequestWindowAttention: desktop && os === 'windows',
    // macOS hides the window on close instead; there is no tray preference.
    canKeepInSystemTray: desktop && (os === 'windows' || os === 'linux'),
    // Linux desktops update through the distro package manager.
    hasInAppUpdates: desktop && os !== 'linux',
    storageIsDurable: desktop,
    hasStableInstallIdentity: desktop,

    // Encryption. The key is in the OS keychain on desktop, so nothing has to
    // be unlocked per session there.
    keyNeedsSessionPassphrase: !desktop,
    supportsKeyRotation: desktop,

    // Notifications.
    notificationsManagedByOS: desktop,
    usesWebPush: !desktop,

    // Window and process. Only macOS overlays its window controls on the
    // content; Windows and Linux keep a native title bar.
    hasCustomTitleBar: desktop && os === 'macos',
    hasCommandLineFlags: desktop,
    hasNativeLogFiles: desktop,
    // Every browser tab is an instance sharing one origin.
    needsTabCoordination: !desktop,

    // Connection.
    hasNativeConnectionKeepalive: desktop,
    needsWebviewReloadBeforeRelogin: desktop,
    webviewStallsAfterSleep: desktop,

    // Shell integration.
    hasOSIdleDetection: desktop,
    hasDeepLinkEvents: desktop,
    hasWindowFullscreenEvents: desktop,
    syncsNativeTitleBarTheme: desktop,
    hasNativeAppBadge: desktop,
    hasNativeContextMenu: desktop,
    nativeUploads: desktop,
    hasMcpBridge: desktop,
  }
}
