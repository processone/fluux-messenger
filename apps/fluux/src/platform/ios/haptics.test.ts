import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { iosHaptic } from './haptics'
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
let restore = () => {}
afterEach(() => { restore(); invoke.mockClear() })
describe('native haptic boundary', () => {
  it.each(['contextMenu', 'selection'] as const)('confirms %s on iOS', async kind => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    iosHaptic(kind)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin:ios-feedback|haptic', { kind }))
  })
  it.each([{ shell: 'web', os: 'ios' }, { shell: 'mobile', os: 'android' }, { shell: 'desktop', os: 'macos' }] as const)('does nothing on $shell/$os', async host => {
    restore = setPlatformForTesting(host)
    iosHaptic('selection')
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
  })
})
