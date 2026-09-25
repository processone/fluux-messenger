import { afterEach, describe, expect, it, vi } from 'vitest'
import { tauriProxyAdapter } from './tauriProxyAdapter'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('native proxy IPC contract (mocked native boundary)', () => {
  afterEach(() => vi.resetAllMocks())

  it('preserves the endpoint and XMPP identity through the native boundary', async () => {
    invoke.mockResolvedValue({ url: 'ws://127.0.0.1:12345' })
    const server = 'tls://chat.example.test:5223?domain=example.test'
    await expect(tauriProxyAdapter.startProxy(server)).resolves.toEqual({ url: 'ws://127.0.0.1:12345' })
    expect(invoke).toHaveBeenCalledWith('start_xmpp_proxy', { server })
  })

  it('propagates failure and permits a subsequent successful start', async () => {
    const error = new Error('native startup failed')
    invoke.mockRejectedValueOnce(error).mockResolvedValueOnce({ url: 'ws://127.0.0.1:23456' })
    await expect(tauriProxyAdapter.startProxy('example.test')).rejects.toBe(error)
    await expect(tauriProxyAdapter.startProxy('example.test')).resolves.toEqual({ url: 'ws://127.0.0.1:23456' })
  })

  it('awaits stop completion and surfaces stop failure', async () => {
    let finish!: () => void
    invoke.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    let stopped = false
    const pending = tauriProxyAdapter.stopProxy().then(() => { stopped = true })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('stop_xmpp_proxy'))
    expect(stopped).toBe(false)
    finish()
    await pending
    expect(stopped).toBe(true)
    invoke.mockRejectedValueOnce(new Error('stop failed'))
    await expect(tauriProxyAdapter.stopProxy()).rejects.toThrow('stop failed')
  })
})
