import { parseXmppUri, normalizeLoginPrefill, type LoginPrefill } from '@fluux/sdk'

/**
 * Desktop: turn an incoming xmpp: deep link into a validated login prefill.
 * A bare `xmpp:alice@example.com` prefills just the JID; a `?connect` action
 * carries the optional server/resource/lang overrides.
 */
export function loginPrefillFromXmppUri(uri: string): LoginPrefill | null {
  // Note: parseXmppUri requires a full JID (user@domain); bare-domain JIDs
  // (accepted by normalizeLoginPrefill and the web path) cannot be prefilled
  // via an xmpp: URI on desktop — they will not parse and return null here.
  const parsed = parseXmppUri(uri)
  if (!parsed) return null
  return normalizeLoginPrefill({
    jid: parsed.jid,
    server: parsed.params.server,
    resource: parsed.params.resource,
    lang: parsed.params.lang,
  })
}

const WEB_PREFILL_PARAMS = ['jid', 'server', 'resource', 'lang'] as const

/**
 * Web: read prefill params from the current URL query string, validate them,
 * and strip them from the URL (preserving any other params and the hash route)
 * so a manual reload does not re-fire and the values do not linger in the bar.
 */
export function captureWebLoginPrefill(): LoginPrefill | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (!WEB_PREFILL_PARAMS.some((key) => params.has(key))) return null

  const prefill = normalizeLoginPrefill({
    jid: params.get('jid') ?? undefined,
    server: params.get('server') ?? undefined,
    resource: params.get('resource') ?? undefined,
    lang: params.get('lang') ?? undefined,
  })

  // Strip regardless of validation result: a malformed prefill must not survive a reload.
  for (const key of WEB_PREFILL_PARAMS) params.delete(key)
  const query = params.toString()
  const newUrl = window.location.pathname + (query ? `?${query}` : '') + window.location.hash
  window.history.replaceState(null, '', newUrl)

  return prefill
}
