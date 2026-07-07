import { describe, it, expect, beforeEach } from 'vitest'
import { useRoomUiStore } from './roomUiStore'

describe('roomUiStore', () => {
  beforeEach(() => {
    useRoomUiStore.setState({ configModalOpen: false, inviteModalOpen: false })
  })
  it('opens and closes the config modal', () => {
    useRoomUiStore.getState().openConfig()
    expect(useRoomUiStore.getState().configModalOpen).toBe(true)
    useRoomUiStore.getState().closeConfig()
    expect(useRoomUiStore.getState().configModalOpen).toBe(false)
  })
  it('opens and closes the invite modal', () => {
    useRoomUiStore.getState().openInvite()
    expect(useRoomUiStore.getState().inviteModalOpen).toBe(true)
    useRoomUiStore.getState().closeInvite()
    expect(useRoomUiStore.getState().inviteModalOpen).toBe(false)
  })
})
