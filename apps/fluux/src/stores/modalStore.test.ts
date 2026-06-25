import { describe, it, expect, beforeEach } from 'vitest'
import { useModalStore, MODAL_ESCAPE_PRIORITY } from './modalStore'

const reset = () =>
  useModalStore.setState({
    commandPalette: false, shortcutHelp: false, presenceMenu: false,
    quickChat: false, addContact: false, joinRoom: false,
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
})
