import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { createAppDesktopHost, createAppFileIO, isMacosDesktop } from './appDesktopHost'

const tauriFiles = vi.hoisted(() => ({
  save: vi.fn(),
  open: vi.fn(),
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: tauriFiles.save, open: tauriFiles.open }))
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: tauriFiles.writeTextFile,
  readTextFile: tauriFiles.readTextFile,
}))

beforeEach(() => {
  for (const fn of Object.values(tauriFiles)) fn.mockReset()
})

describe('createAppFileIO', () => {
  it('writes the armor to the path the user chose and suggests the default name', async () => {
    tauriFiles.save.mockResolvedValue('/chosen/backup.asc')
    expect(await createAppFileIO().saveFile('openpgp-backup-me.asc', 'ARMOR')).toBe(true)
    expect(tauriFiles.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: 'openpgp-backup-me.asc' }))
    expect(tauriFiles.writeTextFile).toHaveBeenCalledWith('/chosen/backup.asc', 'ARMOR')
  })

  it('writes nothing when the user cancels the save dialog', async () => {
    tauriFiles.save.mockResolvedValue(null)
    expect(await createAppFileIO().saveFile('x.asc', 'ARMOR')).toBe(false)
    expect(tauriFiles.writeTextFile).not.toHaveBeenCalled()
  })

  it('reads the file the user picked', async () => {
    tauriFiles.open.mockResolvedValue('/picked/backup.asc')
    tauriFiles.readTextFile.mockResolvedValue('ARMORED TEXT')
    expect(await createAppFileIO().pickFile()).toBe('ARMORED TEXT')
    expect(tauriFiles.readTextFile).toHaveBeenCalledWith('/picked/backup.asc')
  })

  it('reads the first path when the picker answers with an array', async () => {
    tauriFiles.open.mockResolvedValue(['/first.asc', '/second.asc'])
    tauriFiles.readTextFile.mockResolvedValue('FIRST')
    expect(await createAppFileIO().pickFile()).toBe('FIRST')
    expect(tauriFiles.readTextFile).toHaveBeenCalledWith('/first.asc')
  })

  it('returns null and reads nothing when the user cancels the picker', async () => {
    tauriFiles.open.mockResolvedValue(null)
    expect(await createAppFileIO().pickFile()).toBeNull()
    expect(tauriFiles.readTextFile).not.toHaveBeenCalled()
  })
})

describe('isMacosDesktop', () => {
  it.each([
    [{ shell: 'desktop', os: 'macos' }, true],
    [{ shell: 'desktop', os: 'windows' }, false],
    [{ shell: 'desktop', os: 'linux' }, false],
    [{ shell: 'mobile', os: 'ios' }, false],
    [{ shell: 'web', os: 'macos' }, false],
  ] as const)('answers for %j', (value, expected) => {
    const restore = setPlatformForTesting(value)
    try {
      expect(isMacosDesktop()).toBe(expected)
      expect(createAppDesktopHost().macosDesktop).toBe(expected)
    } finally { restore() }
  })
})
