/**
 * Groups a server's XEP-0045 room configuration form into the sections the
 * room settings dialog shows. The form is server-driven: known vars (XEP-0045
 * registry plus ejabberd extensions) land in a named section and group, and
 * anything else falls into Advanced > Other server options, so no field the
 * server sends is ever hidden.
 */
import type { DataFormField } from '@fluux/sdk'
import { Info, Bell, Lock, MessageSquare, Shield, Archive, AlertTriangle, type LucideIcon } from 'lucide-react'

export type RoomSettingsSectionId = 'general' | 'notifications' | 'access' | 'permissions' | 'moderation' | 'advanced' | 'danger'

/** Group ids double as i18n keys under `rooms.settings.groups`. */
export type RoomSettingsGroupId =
  | 'identity' | 'visibility' | 'joining' | 'participantsCan' | 'privateMessages' | 'memberList'
  | 'voice' | 'visitors' | 'history' | 'features' | 'other'

export interface SectionDef {
  id: RoomSettingsSectionId
  icon: LucideIcon
}

/** Display order. Labels and descriptions live under `rooms.settings.sections.<id>`. */
export const SECTIONS: SectionDef[] = [
  { id: 'general', icon: Info },
  { id: 'notifications', icon: Bell },
  { id: 'access', icon: Lock },
  { id: 'permissions', icon: MessageSquare },
  { id: 'moderation', icon: Shield },
  { id: 'advanced', icon: Archive },
  { id: 'danger', icon: AlertTriangle },
]

interface Placement {
  section: RoomSettingsSectionId
  group: RoomSettingsGroupId
  /** Key under `rooms.settings.fields`: ejabberd's labels read as raw sentence fragments, so known vars get our own. */
  label: string
  /** Boolean var that must be on for this field to show. The field is still submitted while hidden. */
  dependsOn?: string
}

/** Known vars, in display order. */
const PLACEMENT: Record<string, Placement> = {
  'muc#roomconfig_roomname': { section: 'general', group: 'identity', label: 'roomName' },
  'muc#roomconfig_roomdesc': { section: 'general', group: 'identity', label: 'roomDesc' },
  'muc#roomconfig_lang': { section: 'general', group: 'identity', label: 'lang' },

  'muc#roomconfig_publicroom': { section: 'access', group: 'visibility', label: 'publicRoom' },
  'muc#roomconfig_persistentroom': { section: 'access', group: 'visibility', label: 'persistentRoom' },
  'public_list': { section: 'access', group: 'visibility', label: 'publicList' },
  'muc#roomconfig_whois': { section: 'access', group: 'visibility', label: 'whois' },
  'muc#roomconfig_membersonly': { section: 'access', group: 'joining', label: 'membersOnly' },
  'muc#roomconfig_passwordprotectedroom': { section: 'access', group: 'joining', label: 'passwordProtected' },
  'muc#roomconfig_roomsecret': { section: 'access', group: 'joining', label: 'roomSecret', dependsOn: 'muc#roomconfig_passwordprotectedroom' },
  'captcha_protected': { section: 'access', group: 'joining', label: 'captchaProtected' },
  'muc#roomconfig_captcha_whitelist': { section: 'access', group: 'joining', label: 'captchaWhitelist', dependsOn: 'captcha_protected' },
  'muc#roomconfig_maxusers': { section: 'access', group: 'joining', label: 'maxUsers' },
  'allow_subscription': { section: 'access', group: 'joining', label: 'allowSubscription' },

  'muc#roomconfig_changesubject': { section: 'permissions', group: 'participantsCan', label: 'changeSubject' },
  'muc#roomconfig_allowinvites': { section: 'permissions', group: 'participantsCan', label: 'allowInvites' },
  'allow_query_users': { section: 'permissions', group: 'participantsCan', label: 'allowQueryUsers' },
  'muc#roomconfig_allowpm': { section: 'permissions', group: 'privateMessages', label: 'allowPm' },
  'allow_private_messages_from_visitors': { section: 'permissions', group: 'privateMessages', label: 'allowPmFromVisitors' },
  'muc#roomconfig_getmemberlist': { section: 'permissions', group: 'memberList', label: 'getMemberList' },
  'muc#roomconfig_presencebroadcast': { section: 'permissions', group: 'memberList', label: 'presenceBroadcast' },

  'muc#roomconfig_moderatedroom': { section: 'moderation', group: 'voice', label: 'moderatedRoom' },
  'members_by_default': { section: 'moderation', group: 'voice', label: 'membersByDefault' },
  'muc#roomconfig_allowvoicerequests': { section: 'moderation', group: 'visitors', label: 'allowVoiceRequests' },
  'muc#roomconfig_voicerequestmininterval': { section: 'moderation', group: 'visitors', label: 'voiceRequestMinInterval', dependsOn: 'muc#roomconfig_allowvoicerequests' },
  'muc#roomconfig_allowvisitorstatus': { section: 'moderation', group: 'visitors', label: 'allowVisitorStatus' },
  'muc#roomconfig_allowvisitornickchange': { section: 'moderation', group: 'visitors', label: 'allowVisitorNickChange' },

  'mam': { section: 'advanced', group: 'history', label: 'mam' },
  'muc#roomconfig_enablelogging': { section: 'advanced', group: 'history', label: 'enableLogging' },
  'enable_hats': { section: 'advanced', group: 'features', label: 'enableHats' },
  'muc#roomconfig_pubsub': { section: 'advanced', group: 'features', label: 'pubsub' },
}

export interface PlacedField {
  field: DataFormField
  /** Key under `rooms.settings.fields`; absent for vars we do not know, which show the server's label. */
  labelKey?: string
  dependsOn?: string
}
export interface FieldGroup { id: RoomSettingsGroupId; fields: PlacedField[] }

/** Section id -> ordered groups. Known vars follow PLACEMENT order; unknown ones go last in Advanced. */
export function groupFields(fields: DataFormField[]): Map<RoomSettingsSectionId, FieldGroup[]> {
  const out = new Map<RoomSettingsSectionId, FieldGroup[]>()
  const order = Object.keys(PLACEMENT)
  const shown = fields.filter(f => f.type !== 'hidden')
  const known = shown.filter(f => PLACEMENT[f.var]).sort((a, b) => order.indexOf(a.var) - order.indexOf(b.var))
  const unknown = shown.filter(f => !PLACEMENT[f.var])
  const push = (section: RoomSettingsSectionId, group: RoomSettingsGroupId, placed: PlacedField) => {
    const groups = out.get(section) ?? []
    let g = groups.find(x => x.id === group)
    if (!g) { g = { id: group, fields: [] }; groups.push(g) }
    g.fields.push(placed)
    out.set(section, groups)
  }
  for (const f of known) {
    const p = PLACEMENT[f.var]
    push(p.section, p.group, { field: f, labelKey: p.label, dependsOn: p.dependsOn })
  }
  for (const f of unknown) push('advanced', 'other', { field: f })
  return out
}

/** Whether a boolean form value is on (XEP-0004 allows "1" or "true"). */
export const isTrue = (v: string | string[] | undefined) => v === '1' || v === 'true'
