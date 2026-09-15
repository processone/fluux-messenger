/**
 * A rendered row reference, never a wire reference.
 *
 * `id` is the row's client ID. Preserve every available discriminator when
 * passing it between selection, navigation, cache loading and viewport reports.
 * See `docs/MESSAGE_IDENTIFIERS.md`, section 4, for resolution and compatibility.
 *
 * @category Chat
 * @module Core/Types/MessageRow
 */
export interface MessageRowRef {
  readonly id: string
  /** XEP-0421 occupant-id. Absent for 1:1, a local echo, or a pre-XEP-0421 room. */
  readonly occupantId?: string
  /** Archive discriminator within the conversation; never a substitute for `id`. */
  readonly stanzaId?: string
  /**
   * @deprecated Retained for serialized references from older clients.
   * Does not participate in message identity.
   */
  readonly unconfirmed?: boolean
}
