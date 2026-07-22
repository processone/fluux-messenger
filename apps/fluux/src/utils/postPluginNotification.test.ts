import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { postPluginNotification } from './postPluginNotification'

describe('postPluginNotification', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('invokes the plugin notify command with the options verbatim', async () => {
    invoke.mockResolvedValue(null)

    await postPluginNotification({
      title: 'Alice',
      body: 'hello',
      extra: { navType: 'conversation', navTarget: 'alice@example.com' },
    })

    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
      options: {
        title: 'Alice',
        body: 'hello',
        extra: { navType: 'conversation', navTarget: 'alice@example.com' },
      },
    })
  })

  // The defect this module exists to fix: the plugin's own sendNotification()
  // is synchronous and drops the invoke promise, so a rejected notify command
  // left no trace anywhere. Logging it puts the failure in fluux.log, which
  // main.rs feeds from the webview console.
  it('logs a rejected notify command instead of swallowing it', async () => {
    invoke.mockRejectedValue(new Error('notification.notify not allowed by ACL'))

    await postPluginNotification({ title: 'Alice', body: 'hello' })

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logged = errorSpy.mock.calls[0].join(' ')
    expect(logged).toContain('not allowed by ACL')
  })

  it('does not reject when the command fails, so callers stay fire-and-forget', async () => {
    invoke.mockRejectedValue(new Error('boom'))

    await expect(postPluginNotification({ title: 'Alice' })).resolves.toBeUndefined()
  })

  // Control: a successful post must stay silent, or the assertion above would
  // pass for a module that logs unconditionally.
  it('logs nothing when the command succeeds', async () => {
    invoke.mockResolvedValue(null)

    await postPluginNotification({ title: 'Alice', body: 'hello' })

    expect(errorSpy).not.toHaveBeenCalled()
  })
})
