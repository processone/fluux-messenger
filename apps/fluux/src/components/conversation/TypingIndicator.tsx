import { useTranslation } from 'react-i18next'

export interface TypingIndicatorProps {
  /**
   * List of users who are currently typing.
   * Can be JIDs, nicknames, or any string identifier.
   */
  typingUsers: string[]
  /**
   * Optional function to format user identifiers into display names.
   * If not provided, users are displayed as-is.
   * @example (jid) => contacts.get(jid)?.name || getLocalPart(jid)
   */
  formatUser?: (user: string) => string
  /**
   * Additional CSS classes for the container
   */
  className?: string
  /**
   * Visual density. 'default' is the message-view sizing; 'compact' drops the
   * padding and uses text-xs so it fits a sidebar preview line.
   */
  variant?: 'default' | 'compact'
}

/**
 * Displays a typing indicator with animated dots and a list of users who are typing.
 * Used in both 1:1 chats (ChatView) and group chats (RoomView).
 *
 * @example
 * // For 1:1 chats - format JIDs to display names
 * <TypingIndicator
 *   typingUsers={['alice@example.com']}
 *   formatUser={(jid) => contacts.get(jid)?.name || getLocalPart(jid)}
 * />
 *
 * @example
 * // For rooms - use nicknames directly
 * <TypingIndicator typingUsers={['Alice', 'Bob']} />
 */
export function TypingIndicator({ typingUsers, formatUser, className = '', variant = 'default' }: TypingIndicatorProps) {
  const { t } = useTranslation()

  if (typingUsers.length === 0) return null

  // Format user names using the provided function or use as-is
  const names = formatUser ? typingUsers.map(formatUser) : typingUsers

  // Build the typing text based on number of users
  let text: string
  if (names.length === 1) {
    text = t('chat.typing.one', { name: names[0], defaultValue: '{{name}} is typing...' })
  } else if (names.length === 2) {
    text = t('chat.typing.two', { name1: names[0], name2: names[1], defaultValue: '{{name1}} and {{name2}} are typing...' })
  } else if (names.length === 3) {
    text = t('chat.typing.three', {
      name1: names[0],
      name2: names[1],
      name3: names[2],
      defaultValue: '{{name1}}, {{name2}}, and {{name3}} are typing...'
    })
  } else {
    text = t('chat.typing.many', {
      name1: names[0],
      name2: names[1],
      count: names.length - 2,
      defaultValue: '{{name1}}, {{name2}}, and {{count}} others are typing...'
    })
  }

  const containerClass =
    variant === 'compact'
      ? `text-xs text-fluux-muted italic flex items-center gap-1.5 min-w-0 ${className}`
      : `py-2 px-4 text-sm text-fluux-muted italic flex items-center gap-2 ${className}`

  return (
    <div className={containerClass}>
      {/* Dots bounce and shimmer through the aurora hues (delays + colors in CSS). */}
      <span className="flex gap-0.5 flex-shrink-0" aria-hidden="true">
        <span className="size-1.5 rounded-full typing-dot" />
        <span className="size-1.5 rounded-full typing-dot" />
        <span className="size-1.5 rounded-full typing-dot" />
      </span>
      <span className={variant === 'compact' ? 'truncate' : ''}>{text}</span>
    </div>
  )
}
