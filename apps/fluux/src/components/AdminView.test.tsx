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
  commands: [{ node: 'stat-node', name: 'Stat', category: 'stats' }],
  commandsByCategory: {
    user: [],
    stats: [{ node: 'stat-node', name: 'Stat', category: 'stats' }],
    announcement: [],
    other: [],
  },
  isDiscovering: false,
  isAdmin: true,
  discoverMucService: vi.fn(),
  executeCommand: vi.fn(),
  fetchServerStats: vi.fn(),
}

const setActiveCategory = vi.fn()

vi.mock('@fluux/sdk', () => ({
  useAdmin: () => adminState,
  useXMPP: () => ({ client: { muc: { destroyRoom: vi.fn() } } }),
  adminStore: { getState: () => ({ setActiveCategory }) },
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

  it('returns to the overview from the room list level (does not exit)', () => {
    const onBack = vi.fn()
    render(<AdminView activeCategory="rooms" onBack={onBack} />)

    expect(screen.getByText('admin.roomList.title')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('common.back'))

    expect(setActiveCategory).toHaveBeenCalledWith('stats')
    expect(onBack).not.toHaveBeenCalled()
  })

  it('exits admin from the overview / no-category level', () => {
    const onBack = vi.fn()
    render(<AdminView activeCategory={null} onBack={onBack} />)

    fireEvent.click(screen.getByLabelText('common.back'))

    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('AdminView mobile section sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the section sheet from the header menu button', () => {
    render(<AdminView activeCategory="rooms" onBack={vi.fn()} />)

    // The sheet (and its Users section button) is not rendered until opened.
    expect(screen.queryByText('admin.categories.users')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('admin.openSections'))

    expect(screen.getByText('admin.categories.users')).toBeInTheDocument()
  })

  it('navigates and closes the sheet when a main-content section is chosen', () => {
    render(<AdminView activeCategory="rooms" onBack={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('admin.openSections'))
    fireEvent.click(screen.getByRole('button', { name: 'admin.categories.users' }))

    expect(setActiveCategory).toHaveBeenCalledWith('users')
    // Sheet closed → its section buttons are gone again.
    expect(screen.queryByText('admin.categories.users')).not.toBeInTheDocument()
  })
})
