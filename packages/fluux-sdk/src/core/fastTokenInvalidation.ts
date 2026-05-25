/**
 * FAST Token Invalidation (XEP-0484 §6)
 *
 * Invalidation is strictly an authentication-time operation: the client
 * must successfully authenticate with the token and include an
 * `invalidate='true'` attribute on the `<fast/>` element inside the
 * `<authenticate/>` stanza. Once the server confirms, it drops the token
 * and MUST NOT issue a replacement.
 *
 * This module opens a short-lived SASL2 session for that purpose.
 * xmpp.js's built-in FAST module is monkey-patched so the outgoing
 * `<fast/>` carries `invalidate='true'` on this one auth exchange.
 *
 * @see https://xmpp.org/extensions/xep-0484.html#invalidation
 */

import { client } from '@xmpp/client'
import { fetchFastToken, type FastToken } from './fastTokenStorage'
import { getBareJid, getDomain, getLocalPart } from './jid'
import { logInfo, logWarn } from './logger'
import { FAST_TOKEN_INVALIDATION_TIMEOUT_MS } from './modules/connectionTimeouts'

export interface InvalidateFastTokenOptions {
  /** Full or bare JID of the account whose token should be invalidated */
  jid: string
  /** WebSocket URL (ws://, wss://) or host for the XMPP server */
  server: string
  /** Override the default invalidation timeout (ms) */
  timeoutMs?: number
  /**
   * Pre-fetched token to use for the invalidation session. When provided,
   * this function does not read localStorage — letting the caller delete the
   * client-side token synchronously (e.g. before a webview reload) while still
   * invalidating it server-side. Falls back to a localStorage lookup when omitted.
   */
  token?: FastToken | null
}

export interface InvalidateFastTokenResult {
  ok: boolean
  /** Short reason code for diagnostics (e.g., 'no-token', 'timeout') */
  reason?: string
}

/**
 * Attach a one-shot patch to xmpp.js's FAST module so the next auth
 * exchange carries `invalidate='true'` on its `<fast/>` element.
 *
 * Wrapping the `authenticate` callback (rather than replacing `fast.auth`)
 * keeps our change limited to the element mutation and leaves the rest
 * of the xmpp.js FAST flow intact.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchFastForInvalidation(fastModule: any): void {
  const originalAuth = fastModule.auth.bind(fastModule)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastModule.auth = async (args: any) => {
    const origAuthenticate = args.authenticate
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args.authenticate = async (innerArgs: any) => {
      if (Array.isArray(innerArgs?.streamFeatures)) {
        for (const el of innerArgs.streamFeatures) {
          if (el?.name === 'fast' && el?.attrs?.xmlns === 'urn:xmpp:fast:0') {
            el.attrs.invalidate = 'true'
          }
        }
      }
      return origAuthenticate(innerArgs)
    }
    return originalAuth(args)
  }
}

/**
 * Open a short-lived SASL2 session to invalidate a stored FAST token on
 * the server. Best-effort: returns a structured result rather than
 * throwing, so the caller can proceed with logout regardless.
 *
 * The client-side storage entry is NOT deleted here — that remains the
 * caller's responsibility, so this function can be re-tried safely.
 */
export async function invalidateFastTokenOnServer(
  options: InvalidateFastTokenOptions
): Promise<InvalidateFastTokenResult> {
  const { jid, server, timeoutMs = FAST_TOKEN_INVALIDATION_TIMEOUT_MS } = options

  const bareJid = getBareJid(jid)
  const token: FastToken | null = options.token ?? fetchFastToken(bareJid)
  if (!token) {
    return { ok: false, reason: 'no-token' }
  }

  const domain = getDomain(jid)
  const username = getLocalPart(jid)
  if (!domain || !username) {
    return { ok: false, reason: 'invalid-jid' }
  }

  const wsUrl = server.startsWith('ws') ? server : `wss://${server}/ws`

  return new Promise<InvalidateFastTokenResult>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let xmppClient: any = null
    let settled = false
    const settle = (result: InvalidateFastTokenResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (xmppClient) {
        try {
          void xmppClient.stop()
        } catch {
          /* ignore */
        }
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      logWarn(`FAST invalidation: timed out after ${timeoutMs}ms`)
      settle({ ok: false, reason: 'timeout' })
    }, timeoutMs)

    try {
      xmppClient = client({
        service: wsUrl,
        domain,
        username,
        credentials: async (
          authenticate: (creds: Record<string, unknown>, mechanism: string) => Promise<void>,
          mechanisms: string[],
          fast: unknown | null
        ) => {
          if (!fast) {
            throw new Error('FAST not advertised by server')
          }
          // We use the token path only; the fallback mechanism name just
          // needs to parse — it won't actually be used because fast.auth
          // will succeed (or fail and surface as an error).
          const mechanism = mechanisms[0] ?? token.mechanism
          await authenticate({ username, token }, mechanism)
        },
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fastModule = (xmppClient as any).fast
      if (!fastModule) {
        settle({ ok: false, reason: 'no-fast-module' })
        return
      }

      // Override token accessors so xmpp.js uses the token we have, and
      // does not touch localStorage for this transient session.
      fastModule.fetchToken = async () => token
      fastModule.saveToken = () => {
        /* server MUST NOT issue a new token on invalidation (XEP-0484 §6) */
      }
      fastModule.deleteToken = () => {
        /* storage cleanup is handled by the caller */
      }

      patchFastForInvalidation(fastModule)

      xmppClient.on('online', () => {
        logInfo('FAST invalidation: SASL2 success — server dropped the token')
        settle({ ok: true })
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      xmppClient.on('error', (err: any) => {
        const msg = err?.message ?? String(err)
        // A not-authorized / credentials-expired here means the server
        // already considered the token invalid. Functionally the same
        // outcome as a successful invalidation.
        if (
          err?.condition === 'not-authorized' ||
          err?.condition === 'credentials-expired' ||
          msg.includes('not-authorized') ||
          msg.includes('credentials-expired')
        ) {
          logInfo(`FAST invalidation: token already invalid on server (${msg})`)
          settle({ ok: true, reason: 'already-invalid' })
          return
        }
        logWarn(`FAST invalidation: failed (${msg})`)
        settle({ ok: false, reason: msg })
      })

      xmppClient.start().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        logWarn(`FAST invalidation: start() rejected (${msg})`)
        settle({ ok: false, reason: msg })
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logWarn(`FAST invalidation: setup failed (${msg})`)
      settle({ ok: false, reason: msg })
    }
  })
}
