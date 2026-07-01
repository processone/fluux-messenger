import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { ContactList } from './ContactList'
import type { Contact } from '@fluux/sdk'

// Each contact row renders exactly one Avatar — count them to detect over-rendering.
const avatarRenders = { count: 0 }

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

// Stable hover handlers — mirrors the REAL useListKeyboardNav, which caches per-item
// handlers by id so their identity is stable across renders (so React.memo can bail).
const stableEnter = vi.fn()
const stableMove = vi.fn()
vi.mock('@/hooks', () => ({
  useContextMenu: () => ({
    isOpen: false, position: { x: 0, y: 0 }, close: vi.fn(), menuRef: { current: null },
    handleContextMenu: vi.fn(), handleTouchStart: vi.fn(), handleTouchEnd: vi.fn(),
  }),
  useTypeToFocus: () => {},
  useListKeyboardNav: () => ({
    selectedIndex: -1,
    isKeyboardNav: false,
    getItemProps: () => ({ 'data-selected': false, onMouseEnter: stableEnter, onMouseMove: stableMove }),
    getContainerProps: () => ({}),
  }),
}))

vi.mock('./types', () => ({
  useSidebarZone: () => ({ current: null }),
  ContactTooltipContent: () => null,
}))

vi.mock('../Avatar', () => ({
  Avatar: ({ name }: { name: string }) => {
    avatarRenders.count++
    return <div data-testid="avatar">{name}</div>
  },
}))

vi.mock('../Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../RenameContactModal', () => ({ RenameContactModal: () => null }))

vi.mock('../ui/TextInput', () => ({
  TextInput: () => <input data-testid="search" />,
}))

vi.mock('@/utils/statusText', () => ({ getTranslatedStatusText: () => '' }))

vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {} }))

// ContactList now subscribes to the group-encoded sidebar entries and each ContactItem
// self-subscribes to its own contact by jid. The mocks drive both.
const removeContact = vi.fn()
const renameContact = vi.fn(async () => {})
let mockEntries: string[] = []
let mockContacts = new Map<string, Contact>()

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useContactIdentities: () => new Map(),
    useRosterActions: () => ({ removeContact, renameContact }),
    useAdminPermissions: () => ({ isAdmin: false, hasUserCommands: false, canManageUser: () => false }),
    useEvents: () => ({ subscriptionRequests: [], acceptSubscription: vi.fn(), rejectSubscription: vi.fn() }),
    useBlocking: () => ({ blockJid: vi.fn() }),
    rosterStore: { getState: () => ({ contacts: mockContacts }) },
  }
})

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'online' }),
  // Serves both the parent's `contactSidebarEntries()` selector and each row's
  // `contacts.get(jid)` selector.
  useRosterStore: (selector: (s: { contactSidebarEntries: () => string[]; contacts: Map<string, Contact> }) => unknown) =>
    selector({ contactSidebarEntries: () => mockEntries, contacts: mockContacts }),
}))

const makeContact = (jid: string, over: Partial<Contact> = {}): Contact => ({
  jid,
  name: jid.split('@')[0],
  presence: 'online',
  subscription: 'both',
  ...over,
}) as Contact

describe('ContactList id-only subscription', () => {
  beforeEach(() => { avatarRenders.count = 0 })

  it('renders one row per contact from the sidebar entries', () => {
    const alice = makeContact('alice@example.com')
    const bob = makeContact('bob@example.com')
    const carol = makeContact('carol@example.com', { presence: 'offline' })
    mockContacts = new Map([[alice.jid, alice], [bob.jid, bob], [carol.jid, carol]])
    mockEntries = ['online alice@example.com', 'online bob@example.com', 'offline carol@example.com']

    render(<ContactList onSelectContact={() => {}} />)

    expect(avatarRenders.count).toBe(3)
  })

  it('memoizes rows: re-rendering the parent with unchanged entries re-renders no row', () => {
    const alice = makeContact('alice@example.com')
    const bob = makeContact('bob@example.com')
    mockContacts = new Map([[alice.jid, alice], [bob.jid, bob]])
    mockEntries = ['online alice@example.com', 'online bob@example.com']

    const onSelectContact = () => {}
    const { rerender } = render(<ContactList onSelectContact={onSelectContact} />)
    const afterMount = avatarRenders.count
    expect(afterMount).toBe(2)

    // Each row gets a stable jid + stable handlers, so a parent re-render must NOT
    // cascade into the memoized rows (in production only the row whose own contact
    // changed re-renders, via its per-jid store subscription).
    rerender(<ContactList onSelectContact={onSelectContact} />)
    expect(avatarRenders.count).toBe(afterMount)
  })
})
