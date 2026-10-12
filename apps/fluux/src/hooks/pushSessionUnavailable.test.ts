import { expect, it, vi } from 'vitest'
import { connectionStore } from '@fluux/sdk'
import { endPushSession } from './useNativePush'

vi.mock('@/platform/ios/notificationMirror', () => { throw new Error('Notification module unavailable') })
vi.mock('@fluux/sdk', async () => ({
  connectionStore: (await import('../../../../packages/fluux-sdk/src/stores/connectionStore')).connectionStore,
}))

it('completes push cleanup when an offline notification module cannot load', async () => {
  localStorage.setItem('fluux-push-registration', JSON.stringify({ jid: 'push.example.test', node: 'fixture-node' }))
  localStorage.setItem('fluux-push-token', 'fixture-token')
  await expect(endPushSession()).resolves.toBeUndefined()
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
  expect(localStorage.getItem('fluux-push-token')).toBeNull()
})


it('waits for online disable and gateway unregister despite notification import failure', async () => {
  localStorage.clear()
  connectionStore.setState({ status: 'online', jid: 'fixture@example.com' })
  localStorage.setItem('fluux-push-registration', JSON.stringify({ jid: 'push.example.test', node: 'fixture-node' }))
  localStorage.setItem('fluux-push-account', 'fixture@example.com')
  localStorage.setItem('fluux-push-device-id', 'fixture-device')
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const calls: string[] = []
  const push = {
    registerDevice: vi.fn(), enable: vi.fn(),
    disable: vi.fn(async () => { calls.push('disable'); await pending }),
    unregisterDevice: vi.fn(async () => { calls.push('unregister') }),
  }
  let finished = false
  const ending = endPushSession(push).then(() => { finished = true })
  await vi.waitFor(() => expect(push.disable).toHaveBeenCalled())
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(finished).toBe(false)
  release()
  await ending
  expect(calls).toEqual(['disable', 'unregister'])
  expect(localStorage.getItem('fluux-push-registration')).toBeNull()
})
