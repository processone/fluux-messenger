import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla'

/**
 * Isolate each subscriber so a notification failure cannot interrupt a store
 * action after commit or prevent later subscribers from receiving the update.
 * Install outside subscribeWithSelector to also contain selector exceptions.
 */
export function containSubscriberErrors<
  T,
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(initializer: StateCreator<T, [], Mcs>): StateCreator<T, [], Mcs> {
  return (set, get, api) => {
    const subscribe = api.subscribe
    api.subscribe = (listener) =>
      subscribe((state, previous) => {
        try {
          listener(state, previous)
        } catch (error) {
          console.error('[SDK] Store subscriber failed:', error)
        }
      })
    return initializer(set, get, api)
  }
}
