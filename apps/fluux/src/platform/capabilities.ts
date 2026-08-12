/**
 * What this build of Fluux can do, as a value rather than a runtime probe.
 *
 * The app used to ask `isTauri()` at each decision point. That reads as one
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
  }
}
