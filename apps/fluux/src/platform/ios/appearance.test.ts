import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { setIosAppearance, setIosBackdrop } from './appearance'
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
let restore = () => {}
afterEach(() => { restore(); invoke.mockClear() })
describe('native appearance boundary', () => {
  it.each(['light', 'dark', null] as const)('sends %s on iOS', async style => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    setIosAppearance(style)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith('plugin:ios-feedback|set_appearance', { style }))
  })
  it('keeps the chosen style when only the backdrop changes, after the first write completed', async () => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    setIosAppearance('light')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    await setIosBackdrop('#f4f4f5')
    expect(invoke).toHaveBeenLastCalledWith('plugin:ios-feedback|set_appearance', { style: 'light', background: '#f4f4f5' })
  })
  it('sends one command at a time and only the latest values after it', async () => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    let release = () => {}
    invoke.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const first = setIosBackdrop('#111111')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const stale = setIosBackdrop('#222222')
    const latest = setIosBackdrop('#333333')
    setIosAppearance('dark')
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    release()
    expect(await Promise.all([first, stale, latest])).toEqual([false, false, true])
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith('plugin:ios-feedback|set_appearance', { style: 'dark', background: '#333333' })
  })
  it('reports a rejected paint as not applied and sends the same color again later', async () => {
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    invoke.mockRejectedValueOnce(new Error('Backdrop not applied'))
    expect(await setIosBackdrop('#444444')).toBe(false)
    expect(await setIosBackdrop('#444444')).toBe(true)
  })
  it.each([{ shell: 'web', os: 'ios' }, { shell: 'mobile', os: 'android' }, { shell: 'desktop', os: 'macos' }] as const)('does nothing on $shell/$os', async host => {
    restore = setPlatformForTesting(host)
    setIosAppearance('dark')
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
  })
})
