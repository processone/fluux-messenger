import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { useToastStore } from '@/stores/toastStore'
import { recordBadgeDiagnostic, resetBadgeDiagnosticsForTesting } from './badgeDiagnostics'
import { saveBadgeDiagnostics } from './badgeDiagnosticsExport'

const native = vi.hoisted(() => ({ save: vi.fn(), write: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: native.save }))
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: native.write }))
let restore: () => void
let blob: Blob
beforeEach(() => {
  localStorage.clear()
  resetBadgeDiagnosticsForTesting()
  restore = setPlatformForTesting({ shell: 'desktop', os: 'macos' })
  native.save.mockReset().mockResolvedValue('/disposable/fluux-badge-diagnostics.json')
  native.write.mockReset().mockResolvedValue(undefined)
  useToastStore.setState({ toasts: [] })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { blob = value as Blob; return 'blob:diagnostic-fixture' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: () => blob.arrayBuffer() })))
  recordBadgeDiagnostic({ phase: 'badge-result', status: 'failed', count: 1 })
})
afterEach(() => { restore(); resetBadgeDiagnosticsForTesting(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

describe('separate native diagnostic export', () => {
  it('writes the sanitized journal through the native save adapter', async () => {
    await saveBadgeDiagnostics('Could not save')
    expect(native.save).toHaveBeenCalledWith({ defaultPath: 'fluux-badge-diagnostics.json' })
    expect(native.write).toHaveBeenCalledOnce()
    const bytes = native.write.mock.calls[0][1] as Uint8Array
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ format: 'fluux-badge-diagnostics', events: [expect.objectContaining({ phase: 'badge-result', status: 'failed', count: 1 })] })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagnostic-fixture')
  })
  it('writes nothing when the native dialog is cancelled', async () => {
    native.save.mockResolvedValue(null)
    await saveBadgeDiagnostics('Could not save')
    expect(native.write).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(useToastStore.getState().toasts).toEqual([])
  })
  it('reports write failure instead of silently falling back or claiming success', async () => {
    native.write.mockRejectedValue(new Error('Disposable file write denied'))
    await saveBadgeDiagnostics('Could not save')
    expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({ type: 'error', message: 'Could not save' }))
    expect(native.save).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
})
