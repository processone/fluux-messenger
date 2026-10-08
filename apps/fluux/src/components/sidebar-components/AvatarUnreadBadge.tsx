import { formatUnreadCount } from '@/utils/formatUnreadCount'

interface AvatarUnreadBadgeProps {
  count: number
  tone?: 'accent' | 'neutral'
  label?: string
}

export function AvatarUnreadBadge({ count, tone = 'accent', label }: AvatarUnreadBadgeProps) {
  if (count <= 0) return null

  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      className={`absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 text-white text-[10px] font-bold rounded-full flex items-center justify-center ${tone === 'accent' ? 'bg-fluux-badge-strong' : 'bg-fluux-gray'}`}
    >
      {formatUnreadCount(count)}
    </span>
  )
}
