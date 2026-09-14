import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Room } from '@fluux/sdk'
import { eventsStore } from '@fluux/sdk/stores'
import { RoomVoiceControls } from './RoomVoiceControls'

vi.unmock('@fluux/sdk/react')

const actions = vi.hoisted(() => ({ requestVoice: vi.fn(), approveVoiceRequest: vi.fn(), dismissVoiceRequest: vi.fn() }))
vi.mock('@fluux/sdk', () => ({ useRoomModeration: () => actions }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const request = { id: 'voice-1', roomJid: 'room@example.org', nick: 'Visitor', jid: 'visitor@example.org/mobile' }
const room = (role: string) => ({ jid: request.roomJid, joined: true, nickname: 'Me', selfOccupant: { nick: 'Me', role }, occupants: new Map() }) as Room
const renderControls = (role: string, isConnected = true, allowWhisper = false) => render(
  <RoomVoiceControls room={room(role)} isConnected={isConnected} allowWhisper={allowWhisper}>
    <textarea aria-label="Composer" />
  </RoomVoiceControls>,
)

describe('room voice controls', () => {
  beforeEach(() => { vi.resetAllMocks(); eventsStore.getState().reset() })

  it('replaces a visitor public composer with a request button', async () => {
    renderControls('visitor')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'rooms.requestVoice' }))
    await waitFor(() => expect(actions.requestVoice).toHaveBeenCalledWith(request.roomJid))
  })

  it('keeps whisper composition available for a visitor', () => {
    renderControls('visitor', true, true)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('restores the public composer after a server role update', () => {
    const view = renderControls('visitor')
    view.rerender(<RoomVoiceControls room={room('participant')} isConnected><textarea aria-label="Composer" /></RoomVoiceControls>)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.queryByText('rooms.requestVoice')).not.toBeInTheDocument()
  })

  it('allows another request after successful submission while keeping the visitor muted', async () => {
    actions.requestVoice.mockImplementation(async () => {
      eventsStore.getState().setVoiceRequestStatus(request.roomJid, { status: 'sent' })
    })
    renderControls('visitor')
    fireEvent.click(screen.getByRole('button', { name: 'rooms.requestVoice' }))
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled())
    expect(screen.getByRole('status')).toHaveTextContent('rooms.voiceRequestSent')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'rooms.requestVoice' }))
    await waitFor(() => expect(actions.requestVoice).toHaveBeenCalledTimes(2))
  })

  it('blocks another request offline after successful submission', () => {
    eventsStore.getState().setVoiceRequestStatus(request.roomJid, { status: 'sent' })
    renderControls('visitor', false)
    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(actions.requestVoice).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('blocks duplicate requests while a retry is sending', async () => {
    eventsStore.getState().setVoiceRequestStatus(request.roomJid, { status: 'sent' })
    let finishSend!: () => void
    actions.requestVoice.mockImplementation(() => new Promise<void>(resolve => { finishSend = resolve }))
    renderControls('visitor')
    const button = screen.getByRole('button')
    fireEvent.click(button)
    expect(actions.requestVoice).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(actions.requestVoice).toHaveBeenCalledTimes(1)
    await act(async () => finishSend())
    expect(button).toBeEnabled()
  })

  it('allows retry after a request send fails', async () => {
    actions.requestVoice.mockRejectedValueOnce(new Error('Connection lost'))
    renderControls('visitor')
    fireEvent.click(screen.getByRole('button', { name: 'rooms.requestVoice' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
    expect(screen.getByRole('button', { name: 'rooms.requestVoice' })).toBeEnabled()
  })

  it('lets a moderator grant or dismiss a request in the current room', async () => {
    eventsStore.getState().addVoiceRequest(request)
    eventsStore.getState().addVoiceRequest({ ...request, roomJid: 'other@example.org', nick: 'Other' })
    renderControls('moderator')
    expect(screen.getByText('Visitor')).toBeInTheDocument()
    expect(screen.queryByText('Other')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'rooms.grantVoice' }))
    await waitFor(() => expect(actions.approveVoiceRequest).toHaveBeenCalledWith(request))
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }))
    expect(actions.dismissVoiceRequest).toHaveBeenCalledWith(request.roomJid, request.id)
  })

  it('keeps moderator controls and the room-keyed composer as distinct React children', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<RoomVoiceControls room={room('moderator')} isConnected>
        <textarea key={request.roomJid} aria-label="Composer" />
      </RoomVoiceControls>)
      expect(errors.mock.calls.some(([message]) => String(message).includes('same key'))).toBe(false)
    } finally { errors.mockRestore() }
  })

  it.each(['dismissal', 'confirmed voice'] as const)('does not show a resolved approval error on a later request after %s', async resolution => {
    eventsStore.getState().addVoiceRequest(request)
    eventsStore.getState().setVoiceRequestStatus(request.roomJid, {
      status: 'error', error: 'Approval forbidden', requestId: request.id,
    })
    actions.dismissVoiceRequest.mockImplementation((roomJid: string, id: string) => {
      eventsStore.getState().removeVoiceRequest(roomJid, id)
    })
    renderControls('moderator')
    expect(screen.getByRole('alert')).toHaveTextContent('Approval forbidden')

    if (resolution === 'dismissal') {
      fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'rooms.grantVoice' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'rooms.grantVoice' })).toBeEnabled())
      expect(screen.getByText(request.nick)).toBeInTheDocument()
      act(() => eventsStore.getState().removeVoiceRequestsForOccupant(request.roomJid, request.nick))
    }
    act(() => eventsStore.getState().addVoiceRequest({ ...request, id: 'voice-2' }))

    expect(screen.getByText(request.nick)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an approval rejection only on the request that failed', () => {
    eventsStore.getState().addVoiceRequest(request)
    eventsStore.getState().addVoiceRequest({ ...request, id: 'voice-2', nick: 'Other' })
    eventsStore.getState().setVoiceRequestStatus(request.roomJid, {
      status: 'error', error: 'Approval forbidden', requestId: request.id,
    })
    renderControls('moderator')
    const [failedRow, otherRow] = screen.getAllByRole('listitem')
    expect(within(failedRow).getByRole('alert')).toHaveTextContent('Approval forbidden')
    expect(within(otherRow).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('hides requests from participants', () => {
    eventsStore.getState().addVoiceRequest(request)
    renderControls('participant')
    expect(screen.queryByText('Visitor')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
