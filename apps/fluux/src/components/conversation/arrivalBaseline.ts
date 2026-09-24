/**
 * What an arrival is measured against.
 *
 * NOT "the previous commit". The rows change for reasons that are not arrivals — entering a
 * conversation, a saved position reloading its rows, older history landing above the reader — and
 * each of those re-bases this so the next commit is not read as a message having arrived.
 *
 * It is a value rather than a pair of refs because the two fields only mean something together:
 * the arrival check reads "the count grew OR the bottom row changed", and a half-updated baseline
 * answers that question wrongly.
 *
 * @module Components/Conversation/ArrivalBaseline
 */

export interface ArrivalBaselineValue {
  count: number
  lastMessageId: string | undefined
}

export interface ArrivalBaseline {
  read(): ArrivalBaselineValue
  /** Rows changed and nobody sent anything: measure the next arrival from here. */
  rebase(value: ArrivalBaselineValue): void
  /**
   * Older history landed ABOVE the reader: the count grew and the bottom row did not move.
   *
   * It takes no message id ON PURPOSE. Re-basing the bottom row here would swallow a message that
   * genuinely arrived while the prepend was landing — the arrival check would then see nothing
   * changed, and a reader at the live edge would not be taken to it. Widening this is a signature
   * change, not a one-line edit.
   */
  rebaseCountOnly(count: number): void
}

export function createArrivalBaseline(lastMessageId: string | undefined): ArrivalBaseline {
  let value: ArrivalBaselineValue = { count: 0, lastMessageId }
  return {
    read: () => value,
    rebase: (next) => { value = next },
    rebaseCountOnly: (count) => { value = { ...value, count } },
  }
}
