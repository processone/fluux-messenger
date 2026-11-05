// Intent: FLM-393 assigns shell readiness and bounded old-client retirement to
// the frontend, never graphics diagnosis, storage clearing or retry policy.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  platform: { shell: 'desktop', os: 'macos' },
  generation: 1,
  invoke: vi.fn(),
  listen: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/platform', () => ({ platform: () => fake.platform }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: fake.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: fake.listen }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fake.platform = { shell: 'desktop', os: 'macos' }
  fake.generation = 1
  fake.invoke.mockImplementation(async (command: string) => command === 'startup_attempt' ? fake.generation : undefined)
  fake.listen.mockResolvedValue(fake.remove)
})

async function installed() {
  const { installStartupCleanup } = await import('./startupRecovery')
  const disconnect = vi.fn().mockResolvedValue(undefined)
  const dispose = installStartupCleanup(disconnect)
  await vi.waitFor(() => expect(fake.listen).toHaveBeenCalledOnce())
  const callback = fake.listen.mock.calls[0][1] as (event: { payload: number }) => Promise<void>
  return { disconnect, dispose, callback }
}

describe('native startup frontend boundary', () => {
  it('reports a mounted shell with the document generation, never a later attempt', async () => {
    const { startupAttempt, reportStartupShell } = await import('./startupRecovery')
    expect(await startupAttempt()).toBe(1)
    fake.generation = 2 // Native retry while this outgoing document still exists.
    await reportStartupShell()
    expect(fake.invoke.mock.calls).toEqual([
      ['startup_attempt'], ['startup_shell_ready', { generation: 1 }],
    ])
  })

  it('does nothing on other platforms', async () => {
    fake.platform = { shell: 'web', os: 'macos' }
    const { startupAttempt, reportStartupShell, installStartupCleanup } = await import('./startupRecovery')
    expect(await startupAttempt()).toBeNull()
    await reportStartupShell()
    installStartupCleanup(vi.fn())()
    expect(fake.invoke).not.toHaveBeenCalled()
    expect(fake.listen).not.toHaveBeenCalled()
  })

  it('acknowledges cleanup only after the owned client finishes, once', async () => {
    const { disconnect, dispose, callback } = await installed()
    let finish!: () => void
    disconnect.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const cleanup = callback({ payload: 2 })
    await callback({ payload: 2 })
    expect(disconnect).toHaveBeenCalledOnce()
    expect(fake.invoke).not.toHaveBeenCalled()
    finish()
    await cleanup
    expect(fake.invoke).toHaveBeenCalledWith('startup_cleanup_complete', { generation: 2, succeeded: true })
    dispose()
  })

  it('reports failed retirement instead of requesting a reload', async () => {
    const { disconnect, dispose, callback } = await installed()
    disconnect.mockRejectedValue(new Error('disposable peer closed during cleanup'))
    await callback({ payload: 2 })
    expect(fake.invoke.mock.calls).toEqual([
      ['startup_cleanup_complete', { generation: 2, succeeded: false }],
    ])
    dispose()
  })

  it('removes the listener on unmount and ignores a retired page callback', async () => {
    const { disconnect, dispose, callback } = await installed()
    // Let the asynchronous listener installation retain its disposer.
    await Promise.resolve()
    dispose()
    await callback({ payload: 2 })
    expect(fake.remove).toHaveBeenCalledOnce()
    expect(disconnect).not.toHaveBeenCalled()
  })
})
