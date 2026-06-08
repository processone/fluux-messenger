import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useShallow } from 'zustand/react/shallow'
import { ContactSelector } from './ContactSelector'
import { chatStore } from '@fluux/sdk'
import { useChatStore } from '@fluux/sdk/react'

// useRoster runs once per ContactSelector render — its call count is a render counter.
// vi.hoisted so the (hoisted) vi.mock factory below can reference it.
const { useRosterMock } = vi.hoisted(() => ({ useRosterMock: vi.fn(() => ({ contacts: [] as unknown[] })) }))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('./ui/TextInput', () => ({ TextInput: () => <input data-testid="ti" /> }))

// Keep the REAL chatStore (so we can mutate it) and matchNameOrJid; only mock useRoster.
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return { ...actual, useRoster: useRosterMock }
})
// Keep the REAL useChatStore (so a regression that re-adds the subscription is caught);
// only mock useConnectionStore.
vi.mock('@fluux/sdk/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk/react')>()
  return {
    ...actual,
    useConnectionStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'online' }),
  }
})

// Probe that DOES subscribe to the combined conversations array (the pattern ContactSelector
// used to use). It proves the chatStore mutation below is "live" — i.e. it notifies
// subscribers — so the test can't pass just because the mutation was a no-op.
let probeRenders = 0
function ConversationsProbe() {
  useChatStore(useShallow((s: { conversations: Map<string, unknown> }) => Array.from(s.conversations.values())))
  probeRenders++
  return null
}

describe('ContactSelector subscription scope', () => {
  it('does not re-render when an unrelated conversation changes', () => {
    useRosterMock.mockClear()
    probeRenders = 0

    render(
      <>
        <ContactSelector selectedContacts={[]} onSelectionChange={() => {}} />
        <ConversationsProbe />
      </>
    )
    const rendersAfterMount = useRosterMock.mock.calls.length
    const probeAfterMount = probeRenders
    expect(rendersAfterMount).toBeGreaterThan(0)

    // Mutate the REAL chatStore: a conversation gains activity.
    act(() => {
      chatStore.getState().addConversation({
        id: 'c2-render-test@example.com',
        name: 'C2 Test',
        type: 'chat',
        unreadCount: 0,
      })
    })

    // The probe (subscribed) re-rendered → the mutation really notifies subscribers...
    expect(probeRenders).toBeGreaterThan(probeAfterMount)
    // ...but ContactSelector did NOT, because it reads recent-activity non-reactively.
    expect(useRosterMock.mock.calls.length).toBe(rendersAfterMount)
  })
})
