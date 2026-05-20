/**
 * Thin wrapper around the W3C Credential Management API for saving a
 * password to the user's password manager. Returns a discriminated outcome
 * so callers can fall back to clipboard + toast when the API is missing or
 * the user dismisses the native prompt.
 *
 * Support matrix:
 * - Chromium-based (Chrome, Edge, Tauri Windows WebView2): full support
 * - Safari, Firefox, Tauri macOS WKWebView, Tauri Linux WebKitGTK: 'unsupported'
 */

export type SaveCredentialOutcome = 'saved' | 'unsupported' | 'failed'

export interface SaveCredentialOptions {
  /** Stable identifier the PM uses to match save and autofill across sessions. */
  id: string
  /** Human-readable name shown in the PM entry list. */
  name: string
  /** The secret to store. */
  password: string
}

interface PasswordCredentialCtor {
  new (data: { id: string; password: string; name: string }): Credential
}

export async function saveCredentialToManager(
  opts: SaveCredentialOptions
): Promise<SaveCredentialOutcome> {
  const Ctor = (globalThis as { PasswordCredential?: PasswordCredentialCtor })
    .PasswordCredential
  const store = navigator.credentials?.store?.bind(navigator.credentials)
  if (!Ctor || !store) return 'unsupported'

  try {
    const credential = new Ctor({
      id: opts.id,
      password: opts.password,
      name: opts.name,
    })
    await store(credential)
    return 'saved'
  } catch {
    return 'failed'
  }
}
