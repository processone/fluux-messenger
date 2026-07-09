import { type ReactNode } from 'react'
import { Hash } from 'lucide-react'
import { Avatar, type AvatarSize } from './Avatar'

/**
 * Hash-icon size per avatar size, tuned to roughly 55-60% of the box so the
 * glyph reads clearly without touching the edges. Keeps the fallback
 * consistent across every room-avatar call site.
 */
const HASH_SIZE: Record<AvatarSize, string> = {
  xs: 'size-3.5',
  sm: 'size-4',
  header: 'size-5',
  md: 'size-6',
  lg: 'size-7',
  xl: 'size-12',
}

export interface RoomAvatarProps {
  /** Room JID. Drives the consistent fallback color and identity. */
  identifier: string
  name?: string
  avatarUrl?: string
  size?: AvatarSize
  /** Optional overlay, e.g. the sidebar typing indicator. */
  overlay?: ReactNode
  className?: string
}

/**
 * A room/group avatar: an {@link Avatar} with the room contract baked in —
 * rounded-square shape and a Hash fallback icon — so no caller has to remember
 * that rooms are square. Rooms have no presence, so no presence props here.
 */
export function RoomAvatar({
  identifier,
  name,
  avatarUrl,
  size = 'sm',
  overlay,
  className,
}: RoomAvatarProps) {
  return (
    <Avatar
      shape="square"
      size={size}
      identifier={identifier}
      name={name}
      avatarUrl={avatarUrl}
      overlay={overlay}
      className={className}
      fallbackIcon={<Hash className={HASH_SIZE[size]} />}
    />
  )
}
