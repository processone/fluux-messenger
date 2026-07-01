import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAppUpdateStore, activateUpdate } from './appUpdateStore'

const reset = () =>
  useAppUpdateStore.setState({
    webUpdateReady: false,
    desktopUpdateAvailable: false,
    applyWebUpdate: null,
    openDesktopUpdate: null,
  })

describe('appUpdateStore', () => {
  beforeEach(reset)

  it('starts with no update available and no actions registered', () => {
    const s = useAppUpdateStore.getState()
    expect(s.webUpdateReady).toBe(false)
    expect(s.desktopUpdateAvailable).toBe(false)
    expect(s.applyWebUpdate).toBeNull()
    expect(s.openDesktopUpdate).toBeNull()
  })

  it('setWebUpdateReady(true, fn) marks web ready and registers the apply action', () => {
    const apply = vi.fn()
    useAppUpdateStore.getState().setWebUpdateReady(true, apply)
    const s = useAppUpdateStore.getState()
    expect(s.webUpdateReady).toBe(true)
    expect(s.applyWebUpdate).toBe(apply)
  })

  it('setWebUpdateReady(false) clears ready and the apply action', () => {
    useAppUpdateStore.getState().setWebUpdateReady(true, vi.fn())
    useAppUpdateStore.getState().setWebUpdateReady(false)
    const s = useAppUpdateStore.getState()
    expect(s.webUpdateReady).toBe(false)
    expect(s.applyWebUpdate).toBeNull()
  })

  it('setDesktopUpdateAvailable(true, fn) marks desktop available and registers the open action', () => {
    const open = vi.fn()
    useAppUpdateStore.getState().setDesktopUpdateAvailable(true, open)
    const s = useAppUpdateStore.getState()
    expect(s.desktopUpdateAvailable).toBe(true)
    expect(s.openDesktopUpdate).toBe(open)
  })

  it('setDesktopUpdateAvailable(false) clears available and the open action', () => {
    useAppUpdateStore.getState().setDesktopUpdateAvailable(true, vi.fn())
    useAppUpdateStore.getState().setDesktopUpdateAvailable(false)
    const s = useAppUpdateStore.getState()
    expect(s.desktopUpdateAvailable).toBe(false)
    expect(s.openDesktopUpdate).toBeNull()
  })

  it('activateUpdate runs the web apply action when a web update is ready', () => {
    const apply = vi.fn()
    const open = vi.fn()
    useAppUpdateStore.getState().setWebUpdateReady(true, apply)
    activateUpdate(useAppUpdateStore.getState())
    expect(apply).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('activateUpdate runs the desktop open action when only a desktop update is available', () => {
    const open = vi.fn()
    useAppUpdateStore.getState().setDesktopUpdateAvailable(true, open)
    activateUpdate(useAppUpdateStore.getState())
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('activateUpdate prioritizes the web reload when both channels signal', () => {
    const apply = vi.fn()
    const open = vi.fn()
    useAppUpdateStore.getState().setWebUpdateReady(true, apply)
    useAppUpdateStore.getState().setDesktopUpdateAvailable(true, open)
    activateUpdate(useAppUpdateStore.getState())
    expect(apply).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })

  it('activateUpdate is a no-op when nothing is available', () => {
    expect(() => activateUpdate(useAppUpdateStore.getState())).not.toThrow()
  })
})
