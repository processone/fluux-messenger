import type { AdminUser } from '@fluux/sdk'

interface UserListItemProps {
  user: AdminUser
  onSelect: (user: AdminUser) => void
}

export function UserListItem({ user, onSelect }: UserListItemProps) {
  return (
    <button
      onClick={() => onSelect(user)}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-fluux-hover
                 transition-colors text-start"
    >
      {/* User info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fluux-text truncate">{user.jid}</p>
      </div>
    </button>
  )
}
