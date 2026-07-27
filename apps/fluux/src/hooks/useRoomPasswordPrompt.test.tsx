/**
 * Issue #1126: joining a password-protected room from anywhere but the Join Room
 * modal used to dead-end on the server's 401. These cover the prompt/retry loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RoomJoinError } from '@fluux/sdk'
import { useRoomPasswordPrompt } from './useRoomPasswordPrompt'

const mockJoinRoom = vi.fn()
const mockJoinResult = vi.fn()

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useRoomActions: () => ({ joinRoom: mockJoinRoom, joinResult: mockJoinResult }),
  }
})

const ROOM = 'secret@conference.example.com'

/** Drives the hook and records what the join resolved to. */
function Harness({ onResult }: { onResult: (outcome: string) => void }) {
  const { joinRoomWithPassword, passwordDialog } = useRoomPasswordPrompt()

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          joinRoomWithPassword(ROOM, 'mynick').then(
            (joined) => onResult(joined ? 'joined' : 'cancelled'),
            (err: unknown) => onResult(`threw:${(err as RoomJoinError).condition}`)
          )
        }}
      >
        join
      </button>
      {passwordDialog}
    </div>
  )
}

const clickJoin = () => fireEvent.click(screen.getByText('join'))
const passwordField = () => screen.findByLabelText('rooms.roomPassword')
const submit = async (password: string) => {
  const input = await passwordField()
  fireEvent.change(input, { target: { value: password } })
  fireEvent.submit(input)
}

describe('useRoomPasswordPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockJoinRoom.mockResolvedValue(undefined)
    mockJoinResult.mockResolvedValue(undefined)
  })

  it('joins without prompting when the room takes no password', async () => {
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)
    clickJoin()

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('joined'))
    expect(screen.queryByLabelText('rooms.roomPassword')).not.toBeInTheDocument()
    expect(mockJoinRoom).toHaveBeenCalledWith(ROOM, 'mynick', undefined)
  })

  it('prompts on a 401 and retries with the password', async () => {
    mockJoinResult
      .mockRejectedValueOnce(new RoomJoinError(ROOM, 'not-authorized'))
      .mockResolvedValue(undefined)
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)
    clickJoin()

    await submit('s3cret')

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('joined'))
    expect(mockJoinRoom).toHaveBeenLastCalledWith(ROOM, 'mynick', { password: 's3cret' })
    // Dialog dismissed once we are in.
    expect(screen.queryByLabelText('rooms.roomPassword')).not.toBeInTheDocument()
  })

  it('re-prompts with an "incorrect password" hint after a wrong password', async () => {
    mockJoinResult.mockRejectedValue(new RoomJoinError(ROOM, 'not-authorized'))
    render(<Harness onResult={vi.fn()} />)
    clickJoin()

    expect(await screen.findByText('rooms.passwordRequired')).toBeInTheDocument()
    await submit('wrong')

    expect(await screen.findByText('rooms.incorrectPassword')).toBeInTheDocument()
    // Still asking, not bounced out to an error toast.
    expect(await passwordField()).toBeInTheDocument()
  })

  it('reports a cancelled prompt as "not joined" rather than an error', async () => {
    mockJoinResult.mockRejectedValue(new RoomJoinError(ROOM, 'not-authorized'))
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)
    clickJoin()

    fireEvent.click(await screen.findByText('common.cancel'))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('cancelled'))
  })

  it('rethrows failures that a password cannot fix', async () => {
    mockJoinResult.mockRejectedValue(new RoomJoinError(ROOM, 'conflict'))
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)
    clickJoin()

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('threw:conflict'))
    expect(screen.queryByLabelText('rooms.roomPassword')).not.toBeInTheDocument()
  })
})
