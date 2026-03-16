import { describe, it, expect } from 'vitest'
import {
  canSetAffiliation,
  canSetRole,
  canKick,
  canBan,
  canModerate,
  getAvailableAffiliations,
  getAvailableRoles,
} from './mucPermissions'

describe('canSetAffiliation', () => {
  describe('owner actor', () => {
    it('can set any affiliation on anyone', () => {
      const targets = ['owner', 'admin', 'member', 'none', 'outcast'] as const
      const newAffs = ['owner', 'admin', 'member', 'none', 'outcast'] as const
      for (const target of targets) {
        for (const newAff of newAffs) {
          expect(canSetAffiliation('owner', target, newAff)).toBe(true)
        }
      }
    })
  })

  describe('admin actor', () => {
    it('can set member/none/outcast on members', () => {
      expect(canSetAffiliation('admin', 'member', 'none')).toBe(true)
      expect(canSetAffiliation('admin', 'member', 'outcast')).toBe(true)
    })

    it('can set member/outcast/none on unaffiliated users', () => {
      expect(canSetAffiliation('admin', 'none', 'member')).toBe(true)
      expect(canSetAffiliation('admin', 'none', 'outcast')).toBe(true)
    })

    it('can unban outcasts', () => {
      expect(canSetAffiliation('admin', 'outcast', 'none')).toBe(true)
      expect(canSetAffiliation('admin', 'outcast', 'member')).toBe(true)
    })

    it('cannot promote to owner or admin', () => {
      expect(canSetAffiliation('admin', 'member', 'owner')).toBe(false)
      expect(canSetAffiliation('admin', 'member', 'admin')).toBe(false)
      expect(canSetAffiliation('admin', 'none', 'owner')).toBe(false)
      expect(canSetAffiliation('admin', 'none', 'admin')).toBe(false)
    })

    it('cannot modify other admins', () => {
      expect(canSetAffiliation('admin', 'admin', 'member')).toBe(false)
      expect(canSetAffiliation('admin', 'admin', 'none')).toBe(false)
      expect(canSetAffiliation('admin', 'admin', 'outcast')).toBe(false)
    })

    it('cannot modify owners', () => {
      expect(canSetAffiliation('admin', 'owner', 'admin')).toBe(false)
      expect(canSetAffiliation('admin', 'owner', 'none')).toBe(false)
    })
  })

  describe('member/none/outcast actor', () => {
    it('member cannot set any affiliation', () => {
      expect(canSetAffiliation('member', 'none', 'member')).toBe(false)
      expect(canSetAffiliation('member', 'none', 'outcast')).toBe(false)
    })

    it('none cannot set any affiliation', () => {
      expect(canSetAffiliation('none', 'none', 'member')).toBe(false)
    })

    it('outcast cannot set any affiliation', () => {
      expect(canSetAffiliation('outcast', 'none', 'member')).toBe(false)
    })
  })
})

describe('canSetRole', () => {
  it('moderator can change roles of participants/visitors', () => {
    expect(canSetRole('moderator', 'admin', 'participant', 'member')).toBe(true)
    expect(canSetRole('moderator', 'admin', 'visitor', 'none')).toBe(true)
    expect(canSetRole('moderator', 'admin', 'participant', 'none')).toBe(true)
  })

  it('non-moderators cannot change roles', () => {
    expect(canSetRole('participant', 'admin', 'visitor', 'none')).toBe(false)
    expect(canSetRole('visitor', 'admin', 'participant', 'none')).toBe(false)
  })

  it('moderator cannot change owner roles', () => {
    expect(canSetRole('moderator', 'admin', 'moderator', 'owner')).toBe(false)
  })

  it('moderator (non-owner) cannot change admin roles', () => {
    expect(canSetRole('moderator', 'member', 'moderator', 'admin')).toBe(false)
    expect(canSetRole('moderator', 'admin', 'moderator', 'admin')).toBe(false)
  })

  it('owner-moderator can change admin roles', () => {
    expect(canSetRole('moderator', 'owner', 'moderator', 'admin')).toBe(true)
  })
})

describe('canKick', () => {
  it('moderator can kick members/none/visitors', () => {
    expect(canKick('moderator', 'admin', 'member')).toBe(true)
    expect(canKick('moderator', 'admin', 'none')).toBe(true)
  })

  it('moderator cannot kick owners', () => {
    expect(canKick('moderator', 'admin', 'owner')).toBe(false)
  })

  it('moderator (non-owner) cannot kick admins', () => {
    expect(canKick('moderator', 'admin', 'admin')).toBe(false)
  })

  it('owner-moderator can kick admins', () => {
    expect(canKick('moderator', 'owner', 'admin')).toBe(true)
  })

  it('non-moderator cannot kick anyone', () => {
    expect(canKick('participant', 'admin', 'none')).toBe(false)
  })
})

describe('canBan', () => {
  it('owner can ban anyone', () => {
    expect(canBan('owner', 'admin')).toBe(true)
    expect(canBan('owner', 'member')).toBe(true)
    expect(canBan('owner', 'none')).toBe(true)
  })

  it('admin can ban members and unaffiliated', () => {
    expect(canBan('admin', 'member')).toBe(true)
    expect(canBan('admin', 'none')).toBe(true)
  })

  it('admin cannot ban owners or other admins', () => {
    expect(canBan('admin', 'owner')).toBe(false)
    expect(canBan('admin', 'admin')).toBe(false)
  })

  it('members cannot ban', () => {
    expect(canBan('member', 'none')).toBe(false)
  })
})

describe('getAvailableAffiliations', () => {
  it('owner gets all options except current', () => {
    const result = getAvailableAffiliations('owner', 'member')
    expect(result).toEqual(['owner', 'admin', 'none', 'outcast'])
  })

  it('admin gets member/none/outcast for unaffiliated', () => {
    const result = getAvailableAffiliations('admin', 'none')
    expect(result).toEqual(['member', 'outcast'])
  })

  it('admin gets empty for other admins', () => {
    const result = getAvailableAffiliations('admin', 'admin')
    expect(result).toEqual([])
  })

  it('member gets empty', () => {
    const result = getAvailableAffiliations('member', 'none')
    expect(result).toEqual([])
  })
})

describe('getAvailableRoles', () => {
  it('moderator-admin gets all roles except current for a member target', () => {
    const result = getAvailableRoles('moderator', 'admin', 'participant', 'member')
    expect(result).toEqual(['moderator', 'visitor'])
  })

  it('non-moderator gets empty', () => {
    const result = getAvailableRoles('participant', 'admin', 'participant', 'member')
    expect(result).toEqual([])
  })

  it('moderator gets empty for owner targets', () => {
    const result = getAvailableRoles('moderator', 'admin', 'moderator', 'owner')
    expect(result).toEqual([])
  })
})

describe('canModerate', () => {
  it('moderator can moderate participants and unaffiliated', () => {
    expect(canModerate('moderator', 'admin', 'member')).toBe(true)
    expect(canModerate('moderator', 'admin', 'none')).toBe(true)
  })

  it('moderator cannot moderate owners', () => {
    expect(canModerate('moderator', 'admin', 'owner')).toBe(false)
  })

  it('moderator (non-owner) cannot moderate admins', () => {
    expect(canModerate('moderator', 'admin', 'admin')).toBe(false)
  })

  it('owner-moderator can moderate admins', () => {
    expect(canModerate('moderator', 'owner', 'admin')).toBe(true)
  })

  it('non-moderator cannot moderate anyone', () => {
    expect(canModerate('participant', 'admin', 'none')).toBe(false)
    expect(canModerate('visitor', 'member', 'none')).toBe(false)
  })
})
