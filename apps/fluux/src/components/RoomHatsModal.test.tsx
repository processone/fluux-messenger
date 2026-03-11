import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RoomHatsModal } from './RoomHatsModal'
import { useToastStore } from '@/stores/toastStore'
import type { Room, Hat } from '@fluux/sdk'

// ---- Mock SDK hat methods -----------------------------------------------

const mockListHats = vi.fn()
const mockCreateHat = vi.fn()
const mockDestroyHat = vi.fn()
const mockListHatAssignments = vi.fn()
const mockAssignHat = vi.fn()
const mockUnassignHat = vi.fn()

vi.mock('@fluux/sdk', () => ({
  useRoom: () => ({
    listHats: mockListHats,
    createHat: mockCreateHat,
    destroyHat: mockDestroyHat,
    listHatAssignments: mockListHatAssignments,
    assignHat: mockAssignHat,
    unassignHat: mockUnassignHat,
  }),
  generateConsistentColorHexSync: () => '#888888',
}))

// ---- Mock i18n ----------------------------------------------------------

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'rooms.manageHats': 'Manage Hats',
        'rooms.hatsDefinitions': 'Definitions',
        'rooms.hatsAssignments': 'Assignments',
        'rooms.hatTitle': 'Title',
        'rooms.hatUri': 'URI',
        'rooms.hatHue': 'Hue',
        'rooms.hatHuePlaceholder': '0–360',
        'rooms.hatTitlePlaceholder': 'e.g. Speaker',
        'rooms.hatUriPlaceholder': 'e.g. urn:example:speaker',
        'rooms.addHat': 'Add hat',
        'rooms.destroyHat': 'Delete',
        'rooms.destroyHatConfirm': `Delete hat "${params?.title}"? It will be removed from all assigned users.`,
        'rooms.assignHat': 'Assign',
        'rooms.unassignHat': 'Unassign',
        'rooms.noHats': 'No hats defined for this room',
        'rooms.noAssignments': 'No hats assigned yet',
        'rooms.loadingHats': 'Loading hats...',
        'rooms.hatCreated': 'Hat created',
        'rooms.hatDestroyed': 'Hat destroyed',
        'rooms.hatAssigned': 'Hat assigned',
        'rooms.hatUnassigned': 'Hat unassigned',
        'rooms.hatCreateError': 'Failed to create hat',
        'rooms.hatDestroyError': 'Failed to destroy hat',
        'rooms.hatAssignError': 'Failed to assign hat',
        'rooms.hatUnassignError': 'Failed to unassign hat',
        'rooms.selectHat': 'Select hat',
        'rooms.hatJidPlaceholder': 'user@example.com',
        'common.close': 'Close',
      }
      return translations[key] || key
    },
    i18n: { language: 'en' },
  }),
}))

// ---- Mock ModalShell / ConfirmDialog -----------------------------------

vi.mock('./ModalShell', () => ({
  ModalShell: ({ title, onClose, children }: {
    title: string
    onClose: () => void
    children: React.ReactNode
  }) => (
    <div data-testid="modal-shell">
      <div data-testid="modal-title">{title}</div>
      <button data-testid="modal-close" onClick={onClose}>Close</button>
      {children}
    </div>
  ),
}))

vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: ({ title, message, onConfirm, onCancel }: {
    title: string
    message: string
    onConfirm: () => void
    onCancel: () => void
  }) => (
    <div data-testid="confirm-dialog">
      <div data-testid="confirm-title">{title}</div>
      <div data-testid="confirm-message">{message}</div>
      <button data-testid="confirm-yes" onClick={onConfirm}>Confirm</button>
      <button data-testid="confirm-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}))

// ---- Test helpers -------------------------------------------------------

const sampleHats: Hat[] = [
  { uri: 'urn:hat:moderator', title: 'Moderator', hue: 210 },
  { uri: 'urn:hat:speaker', title: 'Speaker' },
]

const sampleAssignments = [
  { jid: 'alice@example.com', uri: 'urn:hat:moderator', title: 'Moderator', hue: 210 },
  { jid: 'bob@example.com', uri: 'urn:hat:speaker', title: 'Speaker' },
]

const createRoom = (overrides: Partial<Room> = {}): Room => ({
  jid: 'room@conference.example.com',
  name: 'Test Room',
  joined: true,
  nickname: 'Me',
  messages: [],
  occupants: new Map(),
  typingUsers: new Set(),
  unreadCount: 0,
  mentionsCount: 0,
  isBookmarked: true,
  ...overrides,
})

const mockOnClose = vi.fn()
const mockAddToast = vi.fn()

function renderModal(room?: Room) {
  return render(
    <RoomHatsModal room={room ?? createRoom()} onClose={mockOnClose} />
  )
}

/**
 * On the definitions tab, the search input and the create form title input
 * share the same placeholder ("e.g. Speaker"). The search input is first in DOM.
 * Similarly, on the assignments tab, the search and JID inputs share "user@example.com".
 * These helpers return the correct element by index.
 */
function getSearchInput(placeholder: string): HTMLInputElement {
  return screen.getAllByPlaceholderText(placeholder)[0] as HTMLInputElement
}

function getFormInput(placeholder: string): HTMLInputElement {
  const all = screen.getAllByPlaceholderText(placeholder)
  // The form input is the second one (index 1); if only one exists, return it
  return (all.length > 1 ? all[1] : all[0]) as HTMLInputElement
}

// ---- Tests --------------------------------------------------------------

describe('RoomHatsModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListHats.mockResolvedValue(sampleHats)
    mockListHatAssignments.mockResolvedValue(sampleAssignments)
    mockCreateHat.mockResolvedValue(undefined)
    mockDestroyHat.mockResolvedValue(undefined)
    mockAssignHat.mockResolvedValue(undefined)
    mockUnassignHat.mockResolvedValue(undefined)
    useToastStore.getState().addToast = mockAddToast
    vi.spyOn(useToastStore, 'getState').mockReturnValue({
      ...useToastStore.getState(),
      addToast: mockAddToast,
    })
    // Direct subscription mock for Zustand selector
    vi.mocked(useToastStore as unknown as { (selector: (s: { addToast: typeof mockAddToast }) => unknown): unknown })
      .mockImplementation?.((selector: (s: { addToast: typeof mockAddToast }) => unknown) =>
        selector({ addToast: mockAddToast })
      )
  })

  // ---------- Structure & rendering ----------------------------------------

  describe('Modal structure', () => {
    it('renders with correct title', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByTestId('modal-title')).toHaveTextContent('Manage Hats')
      })
    })

    it('calls onClose when close button clicked', async () => {
      renderModal()
      fireEvent.click(screen.getByTestId('modal-close'))
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })

    it('renders both tab buttons', async () => {
      renderModal()
      expect(screen.getByText('Definitions')).toBeInTheDocument()
      expect(screen.getByText('Assignments')).toBeInTheDocument()
    })

    it('starts on definitions tab', async () => {
      renderModal()
      await waitFor(() => {
        expect(mockListHats).toHaveBeenCalledWith('room@conference.example.com')
      })
    })
  })

  // ---------- Definitions tab ---------------------------------------------

  describe('Definitions tab', () => {
    it('loads and displays hat definitions', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
        expect(screen.getByText('Speaker')).toBeInTheDocument()
      })
    })

    it('displays hat URIs', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('urn:hat:moderator')).toBeInTheDocument()
        expect(screen.getByText('urn:hat:speaker')).toBeInTheDocument()
      })
    })

    it('shows empty state when no hats defined', async () => {
      mockListHats.mockResolvedValue([])
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('No hats defined for this room')).toBeInTheDocument()
      })
    })

    it('filters hats by search query', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      // Search input is the first input with this placeholder
      const searchInput = getSearchInput('e.g. Speaker')
      fireEvent.change(searchInput, { target: { value: 'Moderator' } })

      expect(screen.getByText('Moderator')).toBeInTheDocument()
      // Speaker hat badge is filtered out, but Speaker may still appear in the form input placeholder
      expect(screen.queryByText('urn:hat:speaker')).not.toBeInTheDocument()
    })

    it('clears search when X button clicked', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('urn:hat:speaker')).toBeInTheDocument()
      })

      const searchInput = getSearchInput('e.g. Speaker')
      fireEvent.change(searchInput, { target: { value: 'Moderator' } })

      // Speaker hat URI should be hidden
      expect(screen.queryByText('urn:hat:speaker')).not.toBeInTheDocument()

      // Clear the search by emptying the input
      fireEvent.change(searchInput, { target: { value: '' } })

      await waitFor(() => {
        expect(screen.getByText('urn:hat:speaker')).toBeInTheDocument()
      })
    })
  })

  // ---------- Create hat ---------------------------------------------------

  describe('Create hat', () => {
    it('renders the create form with title, uri and hue inputs', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })
      // Two inputs with "e.g. Speaker" (search + form), one with URI, one with hue
      expect(screen.getAllByPlaceholderText('e.g. Speaker').length).toBeGreaterThanOrEqual(2)
      expect(screen.getByPlaceholderText('e.g. urn:example:speaker')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('0–360')).toBeInTheDocument()
    })

    it('disables Add button when title is empty', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      const addButton = screen.getByText('Add hat').closest('button')!
      expect(addButton).toBeDisabled()
    })

    it('disables Add button when uri is empty', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      // Fill title but not URI (use the form input, not search)
      const titleInput = getFormInput('e.g. Speaker')
      fireEvent.change(titleInput, { target: { value: 'Expert' } })

      const addButton = screen.getByText('Add hat').closest('button')!
      expect(addButton).toBeDisabled()
    })

    it('calls createHat and refreshes on valid submit', async () => {
      const updatedHats = [...sampleHats, { uri: 'urn:hat:expert', title: 'Expert' }]
      mockListHats
        .mockResolvedValueOnce(sampleHats) // Initial load
        .mockResolvedValueOnce(updatedHats) // After create

      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      // Fill in title (form input = second with this placeholder)
      const titleInput = getFormInput('e.g. Speaker')
      fireEvent.change(titleInput, { target: { value: 'Expert' } })

      // Fill in URI
      const uriInput = screen.getByPlaceholderText('e.g. urn:example:speaker')
      fireEvent.change(uriInput, { target: { value: 'urn:hat:expert' } })

      // Click add
      fireEvent.click(screen.getByText('Add hat'))

      await waitFor(() => {
        expect(mockCreateHat).toHaveBeenCalledWith(
          'room@conference.example.com',
          'Expert',
          'urn:hat:expert',
          undefined,
        )
      })
    })

    it('passes hue when provided', async () => {
      mockListHats.mockResolvedValue(sampleHats)

      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.change(getFormInput('e.g. Speaker'), { target: { value: 'VIP' } })
      fireEvent.change(screen.getByPlaceholderText('e.g. urn:example:speaker'), { target: { value: 'urn:hat:vip' } })
      fireEvent.change(screen.getByPlaceholderText('0–360'), { target: { value: '120' } })

      fireEvent.click(screen.getByText('Add hat'))

      await waitFor(() => {
        expect(mockCreateHat).toHaveBeenCalledWith(
          'room@conference.example.com',
          'VIP',
          'urn:hat:vip',
          120,
        )
      })
    })

    it('clears form after successful creation', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      const titleInput = getFormInput('e.g. Speaker')
      const uriInput = screen.getByPlaceholderText('e.g. urn:example:speaker') as HTMLInputElement

      fireEvent.change(titleInput, { target: { value: 'Expert' } })
      fireEvent.change(uriInput, { target: { value: 'urn:hat:expert' } })
      fireEvent.click(screen.getByText('Add hat'))

      await waitFor(() => {
        expect(titleInput.value).toBe('')
        expect(uriInput.value).toBe('')
      })
    })

    it('shows error toast on creation failure', async () => {
      mockCreateHat.mockRejectedValue(new Error('forbidden'))
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.change(getFormInput('e.g. Speaker'), { target: { value: 'X' } })
      fireEvent.change(screen.getByPlaceholderText('e.g. urn:example:speaker'), { target: { value: 'urn:x' } })
      fireEvent.click(screen.getByText('Add hat'))

      await waitFor(() => {
        expect(mockCreateHat).toHaveBeenCalled()
      })
    })
  })

  // ---------- Destroy hat --------------------------------------------------

  describe('Destroy hat', () => {
    it('shows confirmation dialog when delete button clicked', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      // Click the delete button (Trash2 icon) for the first hat
      const deleteButtons = screen.getAllByTitle('Delete')
      fireEvent.click(deleteButtons[0])

      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument()
      expect(screen.getByTestId('confirm-message')).toHaveTextContent(
        'Delete hat "Moderator"?'
      )
    })

    it('calls destroyHat on confirmation', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      // Click delete
      const deleteButtons = screen.getAllByTitle('Delete')
      fireEvent.click(deleteButtons[0])

      // Confirm
      fireEvent.click(screen.getByTestId('confirm-yes'))

      await waitFor(() => {
        expect(mockDestroyHat).toHaveBeenCalledWith(
          'room@conference.example.com',
          'urn:hat:moderator',
        )
      })
    })

    it('dismisses confirmation dialog on cancel', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      const deleteButtons = screen.getAllByTitle('Delete')
      fireEvent.click(deleteButtons[0])

      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument()

      fireEvent.click(screen.getByTestId('confirm-cancel'))

      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
      expect(mockDestroyHat).not.toHaveBeenCalled()
    })
  })

  // ---------- Assignments tab ----------------------------------------------

  describe('Assignments tab', () => {
    it('switches to assignments tab and loads assignments', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      // Click "Assignments" tab
      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(mockListHatAssignments).toHaveBeenCalledWith('room@conference.example.com')
      })
    })

    it('displays assignment JIDs and hat badges', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeInTheDocument()
        expect(screen.getByText('bob@example.com')).toBeInTheDocument()
      })
    })

    it('shows empty state when no assignments', async () => {
      mockListHatAssignments.mockResolvedValue([])
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(screen.getByText('No hats assigned yet')).toBeInTheDocument()
      })
    })

    it('shows unassign button for each assignment', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        const unassignButtons = screen.getAllByText('Unassign')
        expect(unassignButtons).toHaveLength(2)
      })
    })

    it('filters assignments by search query', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeInTheDocument()
      })

      // Search input is the first "user@example.com" placeholder
      const searchInput = getSearchInput('user@example.com')
      fireEvent.change(searchInput, { target: { value: 'alice' } })

      expect(screen.getByText('alice@example.com')).toBeInTheDocument()
      expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument()
    })
  })

  // ---------- Unassign hat -------------------------------------------------

  describe('Unassign hat', () => {
    it('calls unassignHat when unassign button clicked', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeInTheDocument()
      })

      const unassignButtons = screen.getAllByText('Unassign')
      fireEvent.click(unassignButtons[0])

      await waitFor(() => {
        expect(mockUnassignHat).toHaveBeenCalledWith(
          'room@conference.example.com',
          'alice@example.com',
          'urn:hat:moderator',
        )
      })
    })
  })

  // ---------- Assign hat ---------------------------------------------------

  describe('Assign hat', () => {
    it('renders assign form on assignments tab', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(screen.getAllByPlaceholderText('user@example.com').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByText('Assign')).toBeInTheDocument()
      })
    })

    it('populates hat dropdown from definitions', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        const select = screen.getByRole('combobox')
        const options = select.querySelectorAll('option')
        expect(options).toHaveLength(2)
        expect(options[0]).toHaveTextContent('Moderator')
        expect(options[1]).toHaveTextContent('Speaker')
      })
    })

    it('disables Assign button when JID is empty', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        const assignButton = screen.getByText('Assign').closest('button')!
        expect(assignButton).toBeDisabled()
      })
    })

    it('disables Assign button when JID has no @', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeInTheDocument()
      })

      // Form JID input is the second one with "user@example.com" placeholder
      const jidInput = getFormInput('user@example.com')
      fireEvent.change(jidInput, { target: { value: 'invalid-jid' } })

      const assignButton = screen.getByText('Assign').closest('button')!
      expect(assignButton).toBeDisabled()
    })

    it('calls assignHat with valid JID and selected hat URI', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeInTheDocument()
      })

      // Enter a JID (form input = second with this placeholder)
      const jidInput = getFormInput('user@example.com')
      fireEvent.change(jidInput, { target: { value: 'charlie@example.com' } })

      // Click Assign
      fireEvent.click(screen.getByText('Assign'))

      await waitFor(() => {
        expect(mockAssignHat).toHaveBeenCalledWith(
          'room@conference.example.com',
          'charlie@example.com',
          'urn:hat:moderator', // First hat is pre-selected
        )
      })
    })

    it('clears JID input after successful assignment', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        expect(screen.getByText('alice@example.com')).toBeInTheDocument()
      })

      const jidInput = getFormInput('user@example.com')
      fireEvent.change(jidInput, { target: { value: 'charlie@example.com' } })
      fireEvent.click(screen.getByText('Assign'))

      await waitFor(() => {
        expect(jidInput.value).toBe('')
      })
    })
  })

  // ---------- Error handling -----------------------------------------------

  describe('Error handling', () => {
    it('handles listHats failure gracefully', async () => {
      mockListHats.mockRejectedValue(new Error('server error'))
      renderModal()

      // Should not crash, should render the modal
      await waitFor(() => {
        expect(screen.getByTestId('modal-shell')).toBeInTheDocument()
      })
    })

    it('handles listHatAssignments failure gracefully', async () => {
      mockListHatAssignments.mockRejectedValue(new Error('server error'))
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      // Should not crash
      await waitFor(() => {
        expect(screen.getByTestId('modal-shell')).toBeInTheDocument()
      })
    })
  })

  // ---------- Tab state management -----------------------------------------

  describe('Tab switching', () => {
    it('clears search when switching tabs', async () => {
      renderModal()
      await waitFor(() => {
        expect(screen.getByText('Moderator')).toBeInTheDocument()
      })

      // Type in search (first input with this placeholder)
      const searchInput = getSearchInput('e.g. Speaker')
      fireEvent.change(searchInput, { target: { value: 'test' } })
      expect(searchInput.value).toBe('test')

      // Switch tab
      fireEvent.click(screen.getByText('Assignments'))

      // Search should be cleared (new placeholder for assignments tab)
      await waitFor(() => {
        const newSearchInput = getSearchInput('user@example.com')
        expect(newSearchInput.value).toBe('')
      })
    })

    it('shows hat counts in tab headers after loading', async () => {
      renderModal()
      await waitFor(() => {
        // After definitions load, should show count "2"
        expect(screen.getByText('2')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText('Assignments'))

      await waitFor(() => {
        // After assignments load, should also show their count
        expect(mockListHatAssignments).toHaveBeenCalled()
      })
    })
  })
})
