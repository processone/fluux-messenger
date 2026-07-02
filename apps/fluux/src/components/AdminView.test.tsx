import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { AdminRoom } from '@fluux/sdk'

// Identity translation so we can query by key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/hooks', () => ({
  useWindowDrag: () => ({ dragRegionProps: { 'data-tauri-drag-region': true } }),
  useModalInput: () => ({ current: null }),
}))

const mockRoom: AdminRoom = { jid: 'testroom@conference.example.com', name: 'Test Room' }
const mockUser = { jid: 'alice@example.com', username: 'alice', isOnline: true }

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
  userList: { items: [mockUser], isLoading: false, hasFetched: true },
  roomList: { items: [mockRoom], isLoading: false, hasFetched: true },
  entityCounts: { users: 1, rooms: 1 },
  serverStats: null,
  hasMoreUsers: false,
  hasMoreRooms: false,
  fetchAllUsers: vi.fn().mockResolvedValue(undefined),
  loadMoreUsers: vi.fn(),
  resetUserList: vi.fn(),
  requestLastActivity: vi.fn(),
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
  fetchUserLastLogin: vi.fn().mockResolvedValue(null),
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

// Locks the Task 4 header: the AdminView header renders the AdminBreadcrumb
// (clickable home crumb + category trail), NOT the old getIcon()+<h2>{getTitle()}</h2>.
// This is screenshot-independent — it asserts the actual rendered breadcrumb DOM.
describe('AdminView breadcrumb', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a clickable home crumb wired to the stats overview at the users list level', () => {
    render(<AdminView activeCategory="users" onBack={vi.fn()} />)

    const nav = screen.getByLabelText('breadcrumb')
    // Home crumb is a clickable button labelled with t('admin.title') ("Administration").
    const home = within(nav).getByRole('button', { name: 'admin.title' })
    // The category crumb is present alongside it.
    expect(within(nav).getByText('admin.categories.users')).toBeInTheDocument()

    // Clicking the home crumb returns to the admin overview (stats category).
    fireEvent.click(home)
    expect(setActiveCategory).toHaveBeenCalledWith('stats')
  })

  it('shows the full Administration > Users > <jid> trail at the user detail level', () => {
    render(<AdminView activeCategory="users" onBack={vi.fn()} />)

    // Drill into a user (selectedUser is local state set by clicking the row).
    fireEvent.click(screen.getByText('alice@example.com'))

    const nav = screen.getByLabelText('breadcrumb')
    // All three crumbs are present: home, category, and the leaf JID.
    expect(within(nav).getByRole('button', { name: 'admin.title' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'admin.categories.users' })).toBeInTheDocument()
    expect(within(nav).getByText('alice@example.com')).toBeInTheDocument()
  })

  it('renders the breadcrumb header, never a standalone getTitle() heading', () => {
    render(<AdminView activeCategory="users" onBack={vi.fn()} />)

    // The header is the <nav aria-label="breadcrumb">, proving the old
    // icon+<h2>{getTitle()}</h2> header was replaced.
    expect(screen.getByLabelText('breadcrumb')).toBeInTheDocument()
    // admin.userView.title ("User") must NOT appear as a header — it is only a
    // fallback crumb label for other categories, never the users-list header.
    expect(screen.queryByText('admin.userView.title')).not.toBeInTheDocument()
  })
})
