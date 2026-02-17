import type { ProxyAdapter } from '@fluux/sdk'

/**
 * Tauri proxy adapter for native TCP/TLS XMPP connections.
 *
 * Uses the Rust-side `start_xmpp_proxy` / `stop_xmpp_proxy` commands
 * to bridge between a local WebSocket (used by xmpp.js) and a remote
 * TCP/TLS connection to the XMPP server.
 *
 * The proxy is always-on: started once and reused across reconnects.
 * DNS/SRV resolution happens per WebSocket connection in Rust.
 */
export const tauriProxyAdapter: ProxyAdapter = {
  async startProxy(server: string) {
    const { invoke } = await import('@tauri-apps/api/core')
    const startedAt = Date.now()
    console.info(`[ProxyAdapter] start_xmpp_proxy start server=${server}`)
    try {
      const result = await invoke<{ url: string }>(
        'start_xmpp_proxy',
        { server },
      )
      console.info(
        `[ProxyAdapter] start_xmpp_proxy ok in ${Date.now() - startedAt}ms url=${result.url}`
      )
      return { url: result.url }
    } catch (err) {
      console.warn(
        `[ProxyAdapter] start_xmpp_proxy failed after ${Date.now() - startedAt}ms`,
        err
      )
      throw err
    }
  },

  async stopProxy() {
    const { invoke } = await import('@tauri-apps/api/core')
    const startedAt = Date.now()
    console.info('[ProxyAdapter] stop_xmpp_proxy start')
    try {
      await invoke('stop_xmpp_proxy')
      console.info(`[ProxyAdapter] stop_xmpp_proxy ok in ${Date.now() - startedAt}ms`)
    } catch (err) {
      console.warn(
        `[ProxyAdapter] stop_xmpp_proxy failed after ${Date.now() - startedAt}ms`,
        err
      )
      throw err
    }
  },
}
