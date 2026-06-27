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
  /**
   * Advanced server field. Accepts the same formats as the manual login
   * server field (see docs/CONNECTION.md): a `ws`/`wss`/`http`/`https` URL,
   * a native-proxy `tls://`/`tcp://` URL, a bare domain (SRV), or `host:port`.
   * Dangerous URI schemes (`javascript:`, `file:`, `data:`, ...) are rejected.
   */
  server?: string
  /** Optional XMPP resource. */
  resource?: string
  /** Optional UI / xml:lang language tag. */
  lang?: string
}

// Security gate: only these schemes may appear in a `scheme://host` connection
// target. `ws`/`wss`/`http`/`https` cover WebSocket and BOSH; `tls`/`tcp` are
// the desktop native-proxy transports (see docs/CONNECTION.md). Dangerous
// schemes (javascript:, file:, data:, blob:, ...) are excluded by omission.
const ALLOWED_SERVER_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:', 'tls:', 'tcp:'])

// A dotted hostname for the scheme-less shorthand: two or more labels of
// alphanumerics/hyphens. Single-label hosts (e.g. `localhost`) are not accepted
// as a bare domain or `host:port` value (they are ambiguous with a scheme
// token); use an explicit `scheme://host` URL for a single-label host.
const HOSTNAME_RE = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/

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
  if (/\s/.test(value)) return undefined

  // Scheme-qualified hierarchical URL (scheme://host...): allowlist the scheme.
  // This branch also catches file:// and javascript://, which are rejected.
  if (value.includes('://')) {
    try {
      const url = new URL(value)
      if (!ALLOWED_SERVER_PROTOCOLS.has(url.protocol)) return undefined
      // Reject embedded credentials (userinfo): a legitimate XMPP endpoint never
      // carries them, and they would be stored verbatim as the connection target.
      if (url.username || url.password) return undefined
      return value
    } catch {
      return undefined
    }
  }

  // No scheme: a bare domain or `host:port` shorthand for the native proxy.
  // Splitting on the first colon distinguishes `host:port` from an opaque URI
  // like `javascript:alert(1)` (whose "port" is not all digits) — so dangerous
  // single-colon schemes never slip through here.
  const colon = value.indexOf(':')
  if (colon === -1) {
    return HOSTNAME_RE.test(value) ? value : undefined
  }
  const host = value.slice(0, colon)
  const port = value.slice(colon + 1)
  if (HOSTNAME_RE.test(host) && /^[0-9]{1,5}$/.test(port)) {
    const portNum = Number(port)
    if (portNum >= 1 && portNum <= 65535) return value
  }
  return undefined
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
