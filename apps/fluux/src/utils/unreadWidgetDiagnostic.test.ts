import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatStore, connectionStore, roomStore } from '@fluux/sdk'
import { clearUnreadWidgetList, resetSharedUnreadWidgetList, startUnreadWidgetPublisher, unreadWidgetDiagnosticContext } from './unreadWidget'
import { observeWidgetBadge, resetWidgetPublisherDiagnostic, widgetPublisherDiagnostic } from './unreadWidgetDiagnostic'
import { sharePushBadge } from './pushBadge'
import { setPlatformForTesting } from '@/platform'

let restorePlatform: () => void

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
// Override the app suite's default fake stores: these transitions use the SDK itself.
vi.mock('@fluux/sdk', async importOriginal => importOriginal<typeof import('@fluux/sdk')>())

beforeEach(() => {
  restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  resetSharedUnreadWidgetList()
  chatStore.getState().reset(); roomStore.getState().reset(); connectionStore.getState().reset()
  connectionStore.setState({ jid: 'fixture@example.test/device', status: 'online', isVerifying: false })
  invoke.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { resetSharedUnreadWidgetList(); restorePlatform(); vi.useRealTimers() })

const context = () => unreadWidgetDiagnosticContext()
const commands = () => invoke.mock.calls.map(([command]) => command)

describe('closed widget diagnostic observations', () => {
  it('keeps inactive and never-observed phases unknown without issuing a command', () => {
    expect(context()).toMatchObject({ online: null, verifying: null, catchingUp: null, replaying: null,
      badgeCommand: 'unknown', badgeAcknowledgement: 'unknown' })
    expect(invoke).not.toHaveBeenCalled()
  })
  it('samples real replay/catch-up store flags while publishing through them', async () => {
    const endReplay = connectionStore.getState().beginReplay()
    const endCatchUp = connectionStore.getState().beginCatchUp()
    startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    expect(context()).toMatchObject({ online: true, verifying: false, catchingUp: true, replaying: true,
      badgeCommand: 'emitted', badgeAcknowledgement: 'accepted' })
    expect(commands()).toEqual(['plugin:push|set_badge', 'plugin:widgets|set_unread_list'])
    endReplay(); endCatchUp(); await vi.advanceTimersByTimeAsync(600)
    expect(context()).toMatchObject({ catchingUp: false, replaying: false, badgeCommand: 'emitted', badgeAcknowledgement: 'accepted' })
  })
  it('distinguishes an emitted command from its pending and accepted acknowledgement', async () => {
    let accept!: () => void
    invoke.mockImplementation(command => command === 'plugin:push|set_badge'
      ? new Promise<void>(resolve => { accept = resolve }) : Promise.resolve())
    startUnreadWidgetPublisher(() => 0)
    await vi.advanceTimersByTimeAsync(600)
    expect(context()).toMatchObject({ badgeCommand: 'emitted', badgeAcknowledgement: 'pending' })
    expect(commands()).toEqual(['plugin:push|set_badge'])
    accept(); await vi.advanceTimersByTimeAsync(1)
    expect(context().badgeAcknowledgement).toBe('accepted')
    expect(commands()).toEqual(['plugin:push|set_badge', 'plugin:widgets|set_unread_list'])
  })
  it('records a rejected acknowledgement without changing the list publication barrier', async () => {
    invoke.mockRejectedValueOnce(new Error('Private synthetic refusal'))
    startUnreadWidgetPublisher(() => 0); await vi.advanceTimersByTimeAsync(600)
    expect(context().badgeAcknowledgement).toBe('rejected')
    expect(commands()).toEqual(['plugin:push|set_badge'])
    expect(JSON.stringify(context())).not.toContain('Private synthetic refusal')
  })
  it('does not expose identities or retain a previous account completion', async () => {
    let accept!: () => void
    invoke.mockImplementation(() => new Promise<void>(resolve => { accept = resolve }))
    startUnreadWidgetPublisher(() => 0); await vi.advanceTimersByTimeAsync(600)
    connectionStore.setState({ jid: 'another@example.test/device', status: 'disconnected' })
    accept(); await vi.advanceTimersByTimeAsync(1)
    expect(context()).toMatchObject({ online: false, badgeCommand: 'unknown', badgeAcknowledgement: 'unknown' })
    expect(Object.keys(context()).sort()).toEqual(['observedAt', 'online', 'verifying', 'catchingUp', 'replaying', 'badgeCommand', 'badgeAcknowledgement'].sort())
    expect(JSON.stringify(context())).not.toMatch(/example\.test|device/)
  })
  it('invalidates observations immediately when clearing the signed-in session', async () => {
    startUnreadWidgetPublisher(() => 0); await vi.advanceTimersByTimeAsync(600)
    expect(context().badgeAcknowledgement).toBe('accepted')
    const clear = clearUnreadWidgetList()
    expect(context()).toMatchObject({ online: null, badgeAcknowledgement: 'unknown' })
    await clear
  })
  it('does not turn a pre-invocation error or a late old observer into an acknowledgement', () => {
    const input = { active: true, owner: 'fixture@example.test', online: true, verifying: false, catchingUp: false, replaying: false }
    const old = observeWidgetBadge(input.owner)
    old('rejected')
    expect(widgetPublisherDiagnostic(input)).toMatchObject({ badgeCommand: 'unknown', badgeAcknowledgement: 'unknown' })
    const current = observeWidgetBadge(input.owner)
    current('issued'); old('acknowledged')
    expect(widgetPublisherDiagnostic(input).badgeAcknowledgement).toBe('pending')
    resetWidgetPublisherDiagnostic(); current('acknowledged')
    expect(widgetPublisherDiagnostic(input).badgeAcknowledgement).toBe('unknown')
  })
  it('never lets a failing diagnostic observer alter badge success or failure', async () => {
    const observe = () => { throw new Error('Synthetic observation failure') }
    const badge = { unread: [], events: 0, notifyAllRooms: [] }
    await expect(sharePushBadge(badge, { force: true, observe })).resolves.toBeUndefined()
    invoke.mockRejectedValueOnce(new Error('Synthetic native failure'))
    await expect(sharePushBadge(badge, { force: true, observe })).rejects.toThrow('Synthetic native failure')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
