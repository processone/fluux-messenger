import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useRoomJoinWarning } from './useRoomJoinWarning'

const mockGetRoomInfo = vi.fn()
const mockAcknowledge = vi.fn()
const mockIsAcknowledged = vi.fn(() => false)

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useRoomActions: () => ({
    getRoomInfo: mockGetRoomInfo,
    acknowledgeNonAnonymousRoom: mockAcknowledge,
    isNonAnonymousRoomAcknowledged: mockIsAcknowledged,
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirmJoin, warningDialog } = useRoomJoinWarning()
  return (
    <div>
      <button type="button" onClick={async () => onResult(await confirmJoin('room@conference.example.com'))}>go</button>
      {warningDialog}
    </div>
  )
}

describe('useRoomJoinWarning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAcknowledged.mockReturnValue(false)
  })

  it('proceeds without a dialog for a semi-anonymous room', async () => {
    mockGetRoomInfo.mockResolvedValue({ isNonAnonymous: false, isPrivate: false, supportsMAM: false, supportsReactions: true, supportsHats: false })
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)

    fireEvent.click(screen.getByText('go'))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByText('rooms.nonAnonWarningConfirm')).not.toBeInTheDocument()
    expect(mockAcknowledge).not.toHaveBeenCalled()
  })

  it('proceeds without a dialog when the room is non-anonymous but private', async () => {
    mockGetRoomInfo.mockResolvedValue({ isNonAnonymous: true, isPrivate: true, supportsMAM: false, supportsReactions: true, supportsHats: false })
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)

    fireEvent.click(screen.getByText('go'))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByText('rooms.nonAnonWarningConfirm')).not.toBeInTheDocument()
  })

  it('warns for a non-anonymous public room and proceeds + acknowledges on confirm', async () => {
    mockGetRoomInfo.mockResolvedValue({ isNonAnonymous: true, isPrivate: false, supportsMAM: false, supportsReactions: true, supportsHats: false })
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)

    fireEvent.click(screen.getByText('go'))

    // Dialog appears; not resolved yet
    await waitFor(() => expect(screen.getByText('rooms.nonAnonWarningConfirm')).toBeInTheDocument())
    expect(onResult).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('rooms.nonAnonWarningConfirm'))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(mockAcknowledge).toHaveBeenCalledWith('room@conference.example.com')
  })

  it('aborts (returns false) and does not acknowledge on cancel', async () => {
    mockGetRoomInfo.mockResolvedValue({ isNonAnonymous: true, isPrivate: false, supportsMAM: false, supportsReactions: true, supportsHats: false })
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)

    fireEvent.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByText('common.cancel')).toBeInTheDocument())

    fireEvent.click(screen.getByText('common.cancel'))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
    expect(mockAcknowledge).not.toHaveBeenCalled()
  })

  it('skips the dialog for an already-acknowledged room', async () => {
    mockGetRoomInfo.mockResolvedValue({ isNonAnonymous: true, isPrivate: false, supportsMAM: false, supportsReactions: true, supportsHats: false })
    mockIsAcknowledged.mockReturnValue(true)
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)

    fireEvent.click(screen.getByText('go'))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByText('rooms.nonAnonWarningConfirm')).not.toBeInTheDocument()
  })

  it('proceeds when room info cannot be fetched (cannot confirm exposure)', async () => {
    mockGetRoomInfo.mockResolvedValue(null)
    const onResult = vi.fn()
    render(<Harness onResult={onResult} />)

    fireEvent.click(screen.getByText('go'))

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
    expect(screen.queryByText('rooms.nonAnonWarningConfirm')).not.toBeInTheDocument()
  })
})
