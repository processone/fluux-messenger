import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalOverlay } from './ModalOverlay'
import { TextInput } from './ui/TextInput'

interface RoomPasswordDialogProps {
  /** Why we are asking: the initial request, or "incorrect password" on a retry. */
  message: string
  /** The entered password (never trimmed - room passwords are opaque strings). */
  onSubmit: (password: string) => void
  onCancel: () => void
}

/**
 * Asks for a MUC room password after the server refused a join with
 * `not-authorized`. Used by {@link useRoomPasswordPrompt} for every join path
 * outside the Join Room modal (sidebar, room view, deep links).
 */
export function RoomPasswordDialog({ message, onSubmit, onCancel }: RoomPasswordDialogProps) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <ModalOverlay onClose={onCancel} focusRef={inputRef} panelClassName="p-4">
      {({ close }) => (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(password)
          }}
        >
          <h3 className="text-lg font-semibold text-fluux-text mb-2">
            {t('rooms.roomPassword')}
          </h3>
          {/* Carries the ask ("this room is password-protected…") or, on a retry,
              the "incorrect password" hint - so the field needs no visible label
              of its own on top of the title. */}
          <p className="text-sm text-fluux-muted mb-4">{message}</p>

          <TextInput
            ref={inputRef}
            id="room-password-prompt"
            aria-label={t('rooms.roomPassword')}
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 mb-4 bg-fluux-bg text-fluux-text rounded
                       border border-transparent focus:border-fluux-brand
                       placeholder:text-fluux-muted"
          />

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={close}
              className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active
                         rounded-lg transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={password.length === 0}
              className="px-4 py-2 text-sm text-fluux-text-on-accent bg-fluux-brand hover:bg-fluux-brand/90
                         disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
            >
              {t('rooms.joinRoom')}
            </button>
          </div>
        </form>
      )}
    </ModalOverlay>
  )
}
