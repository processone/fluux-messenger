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
