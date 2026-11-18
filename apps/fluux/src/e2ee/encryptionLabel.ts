import type { TFunction } from 'i18next'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'

type Encrypted = Extract<ConversationEncryptionState, { kind: 'encrypted' }>

/** The protocol whose tooltips carry their own wording. Any other protocol is named by the SDK's display name. */
const OPENPGP_PROTOCOL_ID = 'openpgp'

/**
 * The tooltip for an encrypted conversation: it names the protocol.
 * `withNewContact` adds the wording for a contact met recently, which the
 * composer lock does not use.
 */
export function encryptionLabel(
  t: TFunction,
  state: Encrypted,
  { withNewContact = false }: { withNewContact?: boolean } = {},
): string {
  if (state.protocolId !== OPENPGP_PROTOCOL_ID) return state.displayName
  if (state.trust === 'verified') return t('chat.encryption.verifiedTooltip')
  if (state.partlyVerified) return t('chat.encryption.unverifiedKeysetTooltip')
  if (withNewContact && state.isNew) return t('chat.encryption.tofuNewTooltip', 'New contact. Verify fingerprint for full trust')
  return t('chat.encryption.openpgpTooltip')
}
