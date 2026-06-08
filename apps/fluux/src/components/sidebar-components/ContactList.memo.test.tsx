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

const removeContact = vi.fn()
const renameContact = vi.fn(async () => {})
let mockContacts: Contact[] = []

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useRoster: () => ({ sortedContacts: mockContacts, removeContact, renameContact }),
    useAdminPermissions: () => ({ isAdmin: false, hasUserCommands: false, canManageUser: () => false }),
  }
})

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'online' }),
}))

const makeContact = (jid: string, over: Partial<Contact> = {}): Contact => ({
  jid,
  name: jid.split('@')[0],
  presence: 'online',
  subscription: 'both',
  ...over,
}) as Contact

describe('ContactList row memoization', () => {
  beforeEach(() => { avatarRenders.count = 0 })

  it('re-renders only the changed contact row when a single contact updates', () => {
    const alice = makeContact('alice@example.com')
    const bob = makeContact('bob@example.com')
    const carol = makeContact('carol@example.com')
    mockContacts = [alice, bob, carol]

    // Stable props that must NOT break the row memo across the re-render.
    const onSelectContact = () => {}
    const { rerender } = render(<ContactList onSelectContact={onSelectContact} />)

    expect(avatarRenders.count).toBeGreaterThan(0)
    const perRowCost = avatarRenders.count / 3 // avatars per row at mount (3 online contacts)
    const afterMount = avatarRenders.count

    // Mirror rosterStore.updatePresence: a NEW contacts array where only bob's object is
    // replaced (alice & carol keep their refs); bob stays "online-ish" (away ≠ offline) so
    // group membership is unchanged — only his row's data differs.
    const bobAway = makeContact('bob@example.com', { presence: 'away' })
    mockContacts = [alice, bobAway, carol]
    rerender(<ContactList onSelectContact={onSelectContact} />)

    const delta = avatarRenders.count - afterMount
    // Only bob's row should re-render — one row's worth, NOT all three.
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThanOrEqual(perRowCost)
  })
})
