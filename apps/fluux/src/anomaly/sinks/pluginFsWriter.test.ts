import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock` factories are hoisted above every import and above plain `const`
// declarations, so a factory closing over an outer `const writeFile` throws
// "Cannot access before initialization" before the suite even loads.
// `vi.hoisted` is the supported way to share state with a hoisted factory.
const { writeFile, platformName } = vi.hoisted(() => ({
  writeFile: vi.fn(async () => {}),
  platformName: { value: 'macos' },
}))

vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile }))
vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/Users/test',
  localDataDir: async () => '/Users/test/.local/share',
}))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: async () => platformName.value }))

import { createPluginFsWriter } from './tauri'

beforeEach(() => {
  writeFile.mockClear()
  platformName.value = 'macos'
})

describe('createPluginFsWriter', () => {
  it('appends to the daily sidecar beside fluux.log on macOS', async () => {
    const write = createPluginFsWriter(() => new Date('2026-07-29T11:47:02Z'))
    await write('{"kind":"anomaly"}')

    expect(writeFile).toHaveBeenCalledTimes(1)
    const [path, bytes, options] = writeFile.mock.calls[0] as unknown as [
      string,
      Uint8Array,
      Record<string, unknown>,
    ]
    expect(path).toBe('/Users/test/Library/Logs/com.processone.fluux/anomalies.2026-07-29.jsonl')
    expect(options).toEqual({ append: true })
    expect(new TextDecoder().decode(bytes)).toBe('{"kind":"anomaly"}\n')
  })

  it('uses localDataDir off macOS, matching dirs::data_local_dir on the Rust side', async () => {
    // Not a hand-built path: localDataDir is LOCAL AppData on Windows (not Roaming)
    // and $XDG_DATA_HOME on Linux (not a hardcoded ~/.local/share).
    platformName.value = 'linux'
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await write('x')
    expect((writeFile.mock.calls[0] as unknown as [string])[0]).toBe(
      '/Users/test/.local/share/com.processone.fluux/logs/anomalies.2026-07-29.jsonl',
    )
  })

  it('terminates every line so two records cannot be concatenated', async () => {
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await write('a')
    await write('b')
    const written = writeFile.mock.calls.map((c) =>
      new TextDecoder().decode((c as unknown as [string, Uint8Array])[1]),
    )
    expect(written).toEqual(['a\n', 'b\n'])
  })

  it('rolls the filename over at the day boundary', async () => {
    let clock = new Date('2026-07-29T23:59:59Z')
    const write = createPluginFsWriter(() => clock)
    await write('before')
    clock = new Date('2026-07-30T00:00:01Z')
    await write('after')

    const paths = writeFile.mock.calls.map((c) => (c as unknown as [string])[0])
    expect(paths[0]).toContain('anomalies.2026-07-29.jsonl')
    expect(paths[1]).toContain('anomalies.2026-07-30.jsonl')
  })

  it('always uses append, never a truncating write', async () => {
    // A non-append write would silently discard the day's log on every record.
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await write('x')
    expect((writeFile.mock.calls[0] as unknown as [string, Uint8Array, unknown])[2]).toEqual({
      append: true,
    })
  })

  it('propagates a write failure so the sink can count it', async () => {
    writeFile.mockRejectedValueOnce(new Error('ENOSPC') as never)
    const write = createPluginFsWriter(() => new Date('2026-07-29T00:00:00Z'))
    await expect(write('x')).rejects.toThrow('ENOSPC')
  })
})
