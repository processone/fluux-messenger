/**
 * Account settings the examples read from the environment.
 *
 * Kept out of the examples themselves so each one opens on what it is meant to
 * show rather than on argument parsing.
 */

import { discoverWebSocket, getDomain, setLogSink } from '@fluux/sdk/core'

/**
 * Send SDK diagnostics to stderr, so stdout carries only what the bot says.
 *
 * Set `FLUUX_DEBUG=1` to see the quiet levels too.
 */
export function routeSdkLogsToStderr(): void {
  const verbose = process.env.FLUUX_DEBUG === '1'
  setLogSink((level, message) => {
    if (verbose || level === 'warn' || level === 'error') {
      process.stderr.write(`[sdk:${level}] ${message}\n`)
    }
  })
}

export interface BotConfig {
  jid: string
  password: string
  /** WebSocket endpoint. Discovered from the JID's domain when unset. */
  server: string
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is not set. See examples/README.md.`)
  }
  return value
}

/**
 * Resolve credentials, discovering the WebSocket endpoint when `FLUUX_SERVER`
 * is not given.
 *
 * The SDK connects over WebSocket only, so a bare domain is not enough: it
 * needs a `wss://` URL. XEP-0156 discovery usually finds it, but a server that
 * publishes no host-meta will need `FLUUX_SERVER` set by hand.
 */
export async function loadConfig(): Promise<BotConfig> {
  const jid = required('FLUUX_JID')
  const password = required('FLUUX_PASSWORD')

  const configured = process.env.FLUUX_SERVER
  if (configured) return { jid, password, server: configured }

  const discovered = await discoverWebSocket(getDomain(jid))
  if (!discovered) {
    throw new Error(
      `Could not discover a WebSocket endpoint for ${getDomain(jid)}. ` +
        'Set FLUUX_SERVER to it, for example wss://example.com:5443/ws.',
    )
  }
  return { jid, password, server: discovered }
}
