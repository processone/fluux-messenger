import { create } from 'zustand'

interface RoomUiState {
  configModalOpen: boolean
  inviteModalOpen: boolean
  openConfig: () => void
  closeConfig: () => void
  openInvite: () => void
  closeInvite: () => void
}

/**
 * Bridges room-chrome modal open-state so slash commands (run in RoomView) can
 * open modals that are rendered in RoomHeader without threading props.
 */
export const useRoomUiStore = create<RoomUiState>((set) => ({
  configModalOpen: false,
  inviteModalOpen: false,
  openConfig: () => set({ configModalOpen: true }),
  closeConfig: () => set({ configModalOpen: false }),
  openInvite: () => set({ inviteModalOpen: true }),
  closeInvite: () => set({ inviteModalOpen: false }),
}))
