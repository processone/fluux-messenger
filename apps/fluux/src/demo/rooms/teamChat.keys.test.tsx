import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { renderStyledMessage } from '@/utils/messageStyles'
import { SELF_NICK } from '../constants'
import { TEAM_ROOM_MESSAGES, getTeamRoom } from './teamChat'

/**
 * Regression guard: the demo Team Chat must render with ZERO React
 * `Each child in a list should have a unique "key" prop` warnings.
 *
 * The styling pipeline (`renderStyledMessage`) returns arrays of segments —
 * code blocks, @mentions, links, lists, blockquotes, headings, inline marks —
 * and every element it produces must carry a key. The per-message row wrappers
 * (mirrored here from `MessageList`) must be keyed too. React 19 emits the key
 * warning through `console.error` during reconciliation, so we render the real
 * demo seed and fail if any such call is made.
 *
 * This locks in the verified-clean state and catches a future regression where
 * a new demo message (or a new styling branch) yields an unkeyed array.
 */
describe('Team Chat demo — no React key warnings', () => {
  afterEach(() => vi.restoreAllMocks())

  const KEY_WARNING = /unique "key" prop/

  it('renders every seeded message body through the styling pipeline without key warnings', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Faithful to RoomView: the user's own nick + the set of occupant nicks
    // drive mention highlighting (XEP-0372 ranges and IRC-style prefixes).
    const knownNicks = new Set(getTeamRoom().occupants.map((o) => o.nick))

    // Mirror MessageList's structure: each message in a keyed row, its body
    // rendered through the real styling pipeline.
    render(
      <div>
        {TEAM_ROOM_MESSAGES.map((m) => (
          <div key={m.id}>
            {m.body
              ? renderStyledMessage(m.body, m.mentions, SELF_NICK, knownNicks, false)
              : null}
          </div>
        ))}
      </div>,
    )

    const keyWarnings = errorSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && KEY_WARNING.test(a)),
    )

    expect(keyWarnings).toEqual([])
  })
})
