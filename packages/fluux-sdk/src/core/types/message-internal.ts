/**
 * Internal message implementation-state.
 *
 * These fields are SDK-internal bookkeeping that used to live on the public
 * {@link BaseMessage} and thus leaked onto `Message` / `RoomMessage`. They are
 * not part of a message's public shape — no application code reads them — so
 * they are kept here, off the exported types.
 *
 * This module is deliberately NOT re-exported from the package index: it is an
 * internal seam. SDK code that needs the fields uses {@link StoredMessage} /
 * {@link StoredRoomMessage} at the write site and the read helpers below, so
 * the cast to the internal shape lives in exactly one place per field.
 */
import type { Message } from './chat'
import type { RoomMessage } from './room'

export interface MessageImplState {
  /**
   * Local persistence opt-out. When true, the message is kept in the in-memory
   * store only — not written to the local IndexedDB cache or the search index.
   * Set for Quick Chat (transient) rooms and MUC whisper placeholders.
   *
   * Independent of server archival: the XEP-0334 `<no-store>` wire hint is added
   * at the send site, not derived from this flag.
   */
  noLocalStore?: boolean
  /**
   * XEP-0308 + XEP-0359: stanza-ids from correction stanzas. When a message is
   * corrected, the MUC service archives the correction as a new stanza with its
   * own stanza-id; other clients may reference that id in replies (XEP-0461),
   * so we track them to keep reply lookups resolving correctly.
   */
  correctionStanzaIds?: string[]
}

/** A stored 1:1 message: the public {@link Message} plus internal impl-state. */
export type StoredMessage = Message & MessageImplState

/** A stored room message: the public {@link RoomMessage} plus internal impl-state. */
export type StoredRoomMessage = RoomMessage & MessageImplState

/**
 * Whether a message is marked local-store-only. Centralizes the read so the
 * cast to the internal shape lives in one place.
 */
export function isNoLocalStore(msg: Message | RoomMessage): boolean {
  return (msg as MessageImplState).noLocalStore === true
}

/**
 * The correction stanza-ids tracked on a message, if any. Centralizes the read
 * so the cast to the internal shape lives in one place.
 */
export function getCorrectionStanzaIds(msg: Message | RoomMessage): string[] | undefined {
  return (msg as MessageImplState).correctionStanzaIds
}
