import { HatCommandError } from '@fluux/sdk'

// Matches the TranslateFn convention in roomJoinError.ts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * Map a failed hat management command to a user-facing toast message.
 *
 * The base message states which operation failed ("Failed to delete hat"); this
 * appends *why* when the SDK could determine it, so the user can tell a server
 * that never answered apart from a server that refused:
 *
 * - `timeout` → the server did not reply within the command's budget
 * - any RFC 6120 condition → the server's own `<text/>`, or the condition token
 *   when it sent none
 * - anything else → the base message alone, rather than inventing a cause
 *
 * @param baseKey i18n key of the operation-specific failure message
 */
export function getHatCommandErrorMessage(t: TranslateFn, err: unknown, baseKey: string): string {
  const base = t(baseKey)
  const reason = getHatCommandFailureReason(t, err)
  return reason ? `${base} — ${reason}` : base
}

function getHatCommandFailureReason(t: TranslateFn, err: unknown): string | undefined {
  if (!(err instanceof HatCommandError)) return undefined

  if (err.condition === 'timeout') return t('rooms.hatCommandNoReply')
  if (err.text) return err.text
  if (err.condition === 'undefined-condition') return undefined
  return err.condition
}
