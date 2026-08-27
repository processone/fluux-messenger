import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { SearchResultItem } from './SearchView'
import { refreshCurrentDay } from '@/stores/currentDayStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({ 'dates.yesterday': 'Yesterday' })[key] ?? key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@fluux/sdk', () => ({
  useSearch: () => ({}),
  chatStore: { getState: () => ({ conversationEntities: new Map() }) },
  roomStore: { getState: () => ({ rooms: new Map() }) },
  getLocalPart: (jid: string) => jid.split('@')[0],
}))

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: (selector: (state: { rooms: Map<string, unknown> }) => unknown) =>
    selector({ rooms: new Map() }),
  useRosterStore: (selector: (state: { contacts: Map<string, unknown> }) => unknown) =>
    selector({ contacts: new Map() }),
}))

vi.mock('../Avatar', () => ({ Avatar: ({ name }: { name: string }) => <div>{name}</div> }))
vi.mock('../RoomAvatar', () => ({ RoomAvatar: ({ name }: { name: string }) => <div>{name}</div> }))
vi.mock('@/hooks', () => ({ useListKeyboardNav: () => ({}) }))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => ({}) }))
vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {}, notifyUserInput: () => {} }))
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: () => '24h' }))
vi.mock('../ui/TextInput', () => ({ TextInput: () => null }))
vi.mock('./types', () => ({ useSidebarZone: () => ({ current: null }) }))

describe('SearchResultItem relative date freshness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    refreshCurrentDay()
  })

  it('updates its memoized timestamp after the local day changes', () => {
    vi.setSystemTime(new Date(2026, 1, 10, 23, 30))
    refreshCurrentDay()

    render(
      <SearchResultItem
        result={{
          indexId: 'result-1',
          messageId: 'message-1',
          conversationId: 'emma@example.com',
          conversationName: 'Emma',
          isRoom: false,
          from: 'emma@example.com',
          timestamp: new Date(2026, 1, 10, 20, 0).getTime(),
          body: 'Hello',
          matchSnippet: { text: 'Hello', matchStart: 0, matchEnd: 5 },
          source: 'local',
        }}
        isActive={false}
        isSelected={false}
        isKeyboardNav={false}
        onSelect={() => {}}
        onGoToMessage={() => {}}
        currentLang="en"
        timeFormat="24h"
      />
    )
    expect(screen.getByText('20:00')).toBeInTheDocument()

    vi.setSystemTime(new Date(2026, 1, 11, 9, 0))
    act(() => {
      refreshCurrentDay()
    })

    expect(screen.getByText('Yesterday')).toBeInTheDocument()
  })
})
