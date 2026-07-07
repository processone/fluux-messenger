import type { CommandCapability, CommandSelf } from './types'

/** Best-effort client-side gate. The server remains authoritative on execution. */
export function hasCapability(cap: CommandCapability | undefined, self?: CommandSelf): boolean {
  if (!cap) return true
  if (!self) return false
  switch (cap) {
    case 'moderator':
      return self.role === 'moderator'
    case 'admin':
      return self.affiliation === 'admin' || self.affiliation === 'owner'
    case 'owner':
      return self.affiliation === 'owner'
  }
}
