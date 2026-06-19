import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { AdminRoom } from '@fluux/sdk'

// Identity translation so we can query by key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({ titleBarClass: '' }),
  useModalInput: () => ({ current: null }),
}))

const mockRoom: AdminRoom = { jid: 'testroom@conference.example.com', name: 'Test Room' }

// Controllable useAdmin/useXMPP. Defaults give a single-room list under the 'rooms' category.
const adminState = {
  currentSession: null,
  isExecuting: false,
  submitForm: vi.fn(),
  previousStep: vi.fn(),
  cancelCommand: vi.fn(),
  clearSession: vi.fn(),
  clearTargetJid: vi.fn(),
  targetJid: null,
  canGoBack: false,
  canGoNext: false,
  userList: { items: [], isLoading: false, hasFetched: true },
  roomList: { items: [mockRoom], isLoading: false, hasFetched: true },
  entityCounts: { users: 0, rooms: 1 },
  hasMoreUsers: false,
  hasMoreRooms: false,
  fetchUsers: vi.fn().mockResolvedValue(undefined),
  loadMoreUsers: vi.fn(),
  resetUserList: vi.fn(),
  fetchRooms: vi.fn().mockResolvedValue(undefined),
  loadMoreRooms: vi.fn(),
  resetRoomList: vi.fn(),
  executeCommandForUser: vi.fn(),
  addUser: vi.fn(),
  vhosts: [],
  selectedVhost: null,
  setSelectedVhost: vi.fn(),
  fetchVhosts: vi.fn().mockResolvedValue(undefined),
  pendingSelectedUserJid: null,
  clearPendingSelectedUserJid: vi.fn(),
  getRoomOptions: vi.fn().mockResolvedValue({ type: 'result', fields: [] }),
  hasCommand: () => false,
}

vi.mock('@fluux/sdk', () => ({
  useAdmin: () => adminState,
  useXMPP: () => ({ client: { muc: { destroyRoom: vi.fn() } } }),
}))

// Import after mocks are registered.
const { AdminView } = await import('./AdminView')

describe('AdminView header back button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('steps from a room detail back to the room list, not all the way to the admin root', () => {
    const onBack = vi.fn()
    render(<AdminView activeCategory="rooms" onBack={onBack} />)

    // Open the room detail.
    fireEvent.click(screen.getByText('Test Room'))
    expect(screen.getByText('admin.roomView.destroy')).toBeInTheDocument()

    // Click the mobile header back arrow.
    fireEvent.click(screen.getByLabelText('common.back'))

    // We should be back on the list (detail gone), and the exit callback must NOT fire.
    expect(screen.queryByText('admin.roomView.destroy')).not.toBeInTheDocument()
    expect(screen.getByText('admin.roomList.title')).toBeInTheDocument()
    expect(onBack).not.toHaveBeenCalled()
  })

  it('calls onBack (exit to admin root) from the room list level', () => {
    const onBack = vi.fn()
    render(<AdminView activeCategory="rooms" onBack={onBack} />)

    // At the list level (no detail open).
    expect(screen.getByText('admin.roomList.title')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('common.back'))

    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
