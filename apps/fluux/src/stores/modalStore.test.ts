import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useModalStore, MODAL_ESCAPE_PRIORITY } from './modalStore'
import * as tooltipBus from '../utils/tooltipBus'

const reset = () =>
  useModalStore.setState({
    commandPalette: false, shortcutHelp: false, presenceMenu: false,
    quickChat: false, newMessage: false, addContact: false, joinRoom: false,
  })

describe('modalStore', () => {
  beforeEach(reset)

  it('starts with all modals closed', () => {
    const s = useModalStore.getState()
    for (const m of MODAL_ESCAPE_PRIORITY) expect(s[m]).toBe(false)
  })

  it('open() opens only the named modal, leaving the others closed', () => {
    useModalStore.getState().open('commandPalette')
    const s = useModalStore.getState()
    expect(s.commandPalette).toBe(true)
    expect(s.quickChat).toBe(false)
    expect(s.addContact).toBe(false)
  })

  it('close() closes the named modal', () => {
    useModalStore.getState().open('quickChat')
    useModalStore.getState().close('quickChat')
    expect(useModalStore.getState().quickChat).toBe(false)
  })

  it('toggle() flips the named modal', () => {
    const { toggle } = useModalStore.getState()
    toggle('shortcutHelp')
    expect(useModalStore.getState().shortcutHelp).toBe(true)
    toggle('shortcutHelp')
    expect(useModalStore.getState().shortcutHelp).toBe(false)
  })

  it('closeAll() closes every modal', () => {
    const { open, closeAll } = useModalStore.getState()
    open('commandPalette')
    open('quickChat')
    closeAll()
    const s = useModalStore.getState()
    for (const m of MODAL_ESCAPE_PRIORITY) expect(s[m]).toBe(false)
  })

  it('closeTopmost() closes the highest-priority open modal and returns true, leaving lower ones open', () => {
    const { open, closeTopmost } = useModalStore.getState()
    open('quickChat') // lower priority
    open('commandPalette') // highest priority
    expect(closeTopmost()).toBe(true)
    expect(useModalStore.getState().commandPalette).toBe(false)
    expect(useModalStore.getState().quickChat).toBe(true)
  })

  it('closeTopmost() returns false when no modal is open', () => {
    expect(useModalStore.getState().closeTopmost()).toBe(false)
  })

  describe('tooltip dismissal on open', () => {
    it('open() dismisses any lingering tooltips so they cannot float over the modal', () => {
      const spy = vi.spyOn(tooltipBus, 'dismissAllTooltips')
      useModalStore.getState().open('commandPalette')
      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })

    it('toggle() dismisses tooltips when opening, but not when closing', () => {
      const spy = vi.spyOn(tooltipBus, 'dismissAllTooltips')
      const { toggle } = useModalStore.getState()

      toggle('shortcutHelp') // closed -> open
      expect(spy).toHaveBeenCalledTimes(1)

      toggle('shortcutHelp') // open -> closed
      expect(spy).toHaveBeenCalledTimes(1)

      spy.mockRestore()
    })

    it('close() does not dismiss tooltips', () => {
      const spy = vi.spyOn(tooltipBus, 'dismissAllTooltips')
      useModalStore.getState().close('quickChat')
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  it('action identities are stable across state changes (so action-only consumers never re-render)', () => {
    const before = useModalStore.getState()
    before.open('commandPalette')
    const after = useModalStore.getState()
    expect(after.open).toBe(before.open)
    expect(after.close).toBe(before.close)
    expect(after.toggle).toBe(before.toggle)
    expect(after.closeAll).toBe(before.closeAll)
    expect(after.closeTopmost).toBe(before.closeTopmost)
  })

  it('opens and closes the newMessage modal', () => {
    useModalStore.getState().open('newMessage')
    expect(useModalStore.getState().newMessage).toBe(true)
    useModalStore.getState().close('newMessage')
    expect(useModalStore.getState().newMessage).toBe(false)
  })
})
