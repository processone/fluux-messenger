import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoomActions, RoomJoinError } from '@fluux/sdk'
import { RoomPasswordDialog } from '@/components/RoomPasswordDialog'

interface PendingPrompt {
  /** Inline hint above the field: the initial ask, or "incorrect password" on a retry. */
  message: string
  /** Resolves with the entered password, or null when the user cancels. */
  resolve: (password: string | null) => void
}

/**
 * Gets the user into a MUC room, asking for the room password when the server
 * refuses with `not-authorized` (issue #1126). `joinRoomWithPassword` covers a
 * plain join; `withPasswordPrompt` wraps any other way in (accepting an
 * invitation, …).
 *
 * The SDK re-sends a password it already knows (bookmark or earlier join in this
 * session), so this only prompts when we genuinely have none or it stopped
 * working. A password that gets us in is stored in the room's XEP-0402 bookmark,
 * so the next launch joins unattended.
 *
 * Resolves `true` when the room was joined and `false` when the user dismissed
 * the prompt. Any other join failure (nickname conflict, banned, …) is rethrown
 * for the caller's existing error handling.
 *
 * Render the returned `passwordDialog` in the component so the prompt can
 * appear; it is `null` when nothing is pending.
 *
 * @example Joining a room
 * const { joinRoomWithPassword, passwordDialog } = useRoomPasswordPrompt()
 * // in a handler:
 * if (!(await joinRoomWithPassword(roomJid, nickname))) return
 * // in JSX:
 * {passwordDialog}
 *
 * @example Any other way into a room (accepting an invitation, …)
 * const { withPasswordPrompt, passwordDialog } = useRoomPasswordPrompt()
 * if (!(await withPasswordPrompt((password) => acceptInvitation(roomJid, password)))) return
 */
export function useRoomPasswordPrompt() {
  const { t } = useTranslation()
  const { joinRoom, joinResult } = useRoomActions()
  const [pending, setPending] = useState<PendingPrompt | null>(null)

  const askForPassword = useCallback((message: string) => {
    return new Promise<string | null>((resolve) => {
      setPending({
        message,
        resolve: (password) => {
          setPending(null)
          resolve(password)
        },
      })
    })
  }, [])

  /**
   * Run `attempt`, asking for the room password if the server refuses with
   * `not-authorized` and retrying until it succeeds or the user gives up.
   *
   * `attempt` receives the password the user typed (undefined on the first,
   * unprompted try) and must reject with a {@link RoomJoinError} carrying the
   * server's outcome — i.e. it has to await the join result, not just send the
   * join. Anything else it throws is rethrown untouched.
   */
  const withPasswordPrompt = useCallback(
    async (attempt: (password?: string) => Promise<void>): Promise<boolean> => {
      const isPasswordRefusal = (err: unknown) =>
        err instanceof RoomJoinError &&
        (err.reason === 'password-required' || err.reason === 'wrong-password')

      try {
        await attempt()
        return true
      } catch (err) {
        if (!isPasswordRefusal(err)) throw err
      }

      // Keep asking until we are in or the user gives up: a mistyped password
      // should reopen the same prompt, not bounce the user out to a toast.
      let message = t('rooms.passwordRequired')
      for (;;) {
        const password = await askForPassword(message)
        if (password === null) return false
        try {
          await attempt(password)
          return true
        } catch (err) {
          if (!isPasswordRefusal(err)) throw err
          message = t('rooms.incorrectPassword')
        }
      }
    },
    [askForPassword, t]
  )

  /** {@link withPasswordPrompt} over a plain room join. */
  const joinRoomWithPassword = useCallback(
    (roomJid: string, nickname: string) =>
      withPasswordPrompt(async (password) => {
        // Room passwords are opaque XMPP strings - never trim them. The
        // unprompted attempt passes no options at all, so joinRoom() falls back
        // to whatever password it already knows for the room.
        if (password === undefined) await joinRoom(roomJid, nickname)
        else await joinRoom(roomJid, nickname, { password })
        await joinResult(roomJid)
      }),
    [withPasswordPrompt, joinRoom, joinResult]
  )

  const passwordDialog = pending ? (
    <RoomPasswordDialog
      message={pending.message}
      onSubmit={(password) => pending.resolve(password)}
      onCancel={() => pending.resolve(null)}
    />
  ) : null

  return { joinRoomWithPassword, withPasswordPrompt, passwordDialog }
}
