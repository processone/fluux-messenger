import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { writeFile } from '@tauri-apps/plugin-fs'
import { createPluginFsWriter } from './tauri'
import { ID } from '../values'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: vi.fn() }))
const nativeDirectory = '/Users/test/Library/Logs/net.processone.fluux'
const line = JSON.stringify({ id: ID.sessionStart.s, sev: 'drift' })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(invoke).mockResolvedValue(nativeDirectory)
  vi.mocked(writeFile).mockResolvedValue(undefined)
})

describe('createPluginFsWriter', () => {
  it('uses the native default directory for the ordinary macOS sidecar', async () => {
    const write = createPluginFsWriter(() => new Date('2026-07-29T11:47:02Z'))
    await write(line)
    expect(invoke).toHaveBeenCalledWith('get_default_log_directory')
    expect(vi.mocked(writeFile).mock.calls[0][0]).toBe(
      '/Users/test/Library/Logs/net.processone.fluux/anomalies.2026-07-29.jsonl',
    )
  })

  it('uses the disposable Windows directory reported by native startup', async () => {
    vi.mocked(invoke).mockResolvedValue('C:\\Users\\test\\AppData\\Local\\net.processone.fluux.dev.gui-test\\logs')
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await write(line)
    expect(vi.mocked(writeFile).mock.calls[0][0]).toBe(
      'C:\\Users\\test\\AppData\\Local\\net.processone.fluux.dev.gui-test\\logs/anomalies.2026-07-29.jsonl',
    )
  })

  it('terminates every line so two records cannot be concatenated', async () => {
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await write(line)
    await write(line)
    const written = vi.mocked(writeFile).mock.calls.map((call) => call[1])
    expect(written).toEqual([
      new TextEncoder().encode(`${line}\n`),
      new TextEncoder().encode(`${line}\n`),
    ])
  })

  it('rolls the filename over at the day boundary', async () => {
    let clock = new Date('2026-07-29T23:59:59Z')
    const write = createPluginFsWriter(() => clock)
    await write(line)
    clock = new Date('2026-07-30T00:00:01Z')
    await write(line)
    const paths = vi.mocked(writeFile).mock.calls.map((call) => call[0])
    expect(paths).toEqual([
      `${nativeDirectory}/anomalies.2026-07-29.jsonl`,
      `${nativeDirectory}/anomalies.2026-07-30.jsonl`,
    ])
  })

  it('always uses append, never a truncating write', async () => {
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await write(line)
    expect(vi.mocked(writeFile).mock.calls[0][2]).toEqual({ append: true })
  })

  it('propagates a write failure so the sink can count it', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC'))
    await expect(createPluginFsWriter()(line)).rejects.toThrow('ENOSPC')
  })

  it('does not fall back to ordinary logs when native directory lookup fails', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('Native log directory unavailable'))
    await expect(createPluginFsWriter()(line)).rejects.toThrow('Native log directory unavailable')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
