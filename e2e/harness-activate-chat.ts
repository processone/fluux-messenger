import { test, expect } from '@playwright/test'
import { loadDemo, activateChat } from './harness/scrollHarness'

/**
 * The shared activateChat helper must end on the conversation it was asked for, even when the
 * app's own startup selection activates after it. FLM-211: scroll-reading-width.ts timed out in
 * setup on a loaded machine with another conversation active.
 *
 * On a desktop-width boot ChatLayout auto-selects the most recent conversation, then its
 * URL-to-store sync activates that conversation again once the router commits the auto-select's
 * route. Under load both can still be in flight when the demo reports ready, so they land after
 * the harness's activation with newer tokens. This test forces that order by holding the app's
 * own activations until the harness issues its activation, then releasing them right after it.
 */
const REQUESTED = 'james@fluux.chat'

test('activateChat ends on the requested chat when the app selects another one after it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.addInitScript((requested) => {
    interface ChatStore {
      getState(): { activateConversation(id: string | null): Promise<void> }
      setState(partial: { activateConversation(id: string | null): Promise<void> }): void
    }
    const scope = window as unknown as { __chatStore?: ChatStore; __releasedAfterHarness?: (string | null)[] }
    let store: ChatStore | undefined
    // demo.tsx assigns __chatStore before the first render, so the wrapper sees every app activation.
    Object.defineProperty(scope, '__chatStore', {
      configurable: true,
      get: () => store,
      set(value: ChatStore) {
        store = value
        const activate = value.getState().activateConversation
        const held: (() => void)[] = []
        const released: (string | null)[] = (scope.__releasedAfterHarness = [])
        let harnessActed = false
        value.setState({
          activateConversation: (id) => {
            if (harnessActed) return activate(id)
            if (id !== requested) {
              return new Promise<void>(resolve => held.push(() => {
                released.push(id)
                resolve(activate(id))
              }))
            }
            const harnessActivation = activate(id)
            harnessActed = true
            for (const release of held) release()
            return harnessActivation
          },
        })
      },
    })
  }, REQUESTED)

  await loadDemo(page)
  await activateChat(page, REQUESTED)

  const state = await page.evaluate(() => {
    const scope = window as unknown as {
      __chatStore: { getState(): { activeConversationId: string | null; activationPending: boolean } }
      __releasedAfterHarness: (string | null)[]
    }
    const chat = scope.__chatStore.getState()
    return {
      active: chat.activeConversationId,
      pending: chat.activationPending,
      route: location.hash,
      releasedAfterHarness: scope.__releasedAfterHarness,
    }
  })
  // Without a startup activation landing after the harness's, this test would prove nothing.
  expect(state.releasedAfterHarness.filter(id => id !== null && id !== REQUESTED).length,
    'the app must have selected another conversation at startup').toBeGreaterThan(0)
  expect(state).toMatchObject({
    active: REQUESTED,
    pending: false,
    route: '#/messages/' + encodeURIComponent(REQUESTED),
  })
})
