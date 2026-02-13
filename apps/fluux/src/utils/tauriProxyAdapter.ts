import type { ProxyAdapter, ConnectionMethod } from '@fluux/sdk'

/**
 * Tauri proxy adapter for native TCP/TLS XMPP connections.
 *
 * Uses the Rust-side `start_xmpp_proxy` / `stop_xmpp_proxy` commands
 * to bridge between a local WebSocket (used by xmpp.js) and a remote
 * TCP/TLS connection to the XMPP server.
 */
export const tauriProxyAdapter: ProxyAdapter = {
  async startProxy(server: string) {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<{ url: string; connection_method: string; resolved_endpoint: string }>(
      'start_xmpp_proxy',
      { server },
    )
    return {
      url: result.url,
      connectionMethod: result.connection_method as ConnectionMethod,
      resolvedEndpoint: result.resolved_endpoint,
    }
  },

  async stopProxy() {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('stop_xmpp_proxy')
  },
}
