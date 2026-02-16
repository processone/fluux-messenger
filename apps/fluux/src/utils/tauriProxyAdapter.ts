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
    const result = await invoke<{ url: string }>(
      'start_xmpp_proxy',
      { server },
    )
    return { url: result.url }
  },

  async stopProxy() {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('stop_xmpp_proxy')
  },
}
