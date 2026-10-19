/**
 * XEP-0313 §6 archiving preferences: stanza building and parsing.
 *
 * @module MAM
 */

import { xml, type Element } from '@xmpp/client'
import { NS_MAM } from '../namespaces'
import { generateUUID } from '../../utils/uuid'
import type { ArchivingDefault, ArchivingPreferences } from '../types'

const ARCHIVING_DEFAULTS: readonly ArchivingDefault[] = ['always', 'never', 'roster']

function isArchivingDefault(value: unknown): value is ArchivingDefault {
  return ARCHIVING_DEFAULTS.includes(value as ArchivingDefault)
}

/** Prefs requests carry no `to`: the archive is the account's own (XEP-0313 §6). */
export function buildPreferencesQuery(): Element {
  return xml('iq', { type: 'get', id: `mam_prefs_${generateUUID()}` }, xml('prefs', { xmlns: NS_MAM }))
}

export function buildPreferencesUpdate(prefs: ArchivingPreferences): Element {
  const jidList = (jids: string[]) => jids.map(jid => xml('jid', {}, jid))
  return xml('iq', { type: 'set', id: `mam_prefs_${generateUUID()}` },
    xml('prefs', { xmlns: NS_MAM, default: prefs.default },
      xml('always', {}, ...jidList(prefs.always)),
      xml('never', {}, ...jidList(prefs.never))))
}

/**
 * Read the `<prefs/>` of an IQ result. Returns null when the result carries no
 * prefs element or no recognised `default` policy.
 */
export function parsePreferences(result: Element): ArchivingPreferences | null {
  const prefs = result.getChild('prefs', NS_MAM)
  const policy = prefs?.attrs.default
  if (!prefs || !isArchivingDefault(policy)) return null
  const jidList = (name: 'always' | 'never') =>
    (prefs.getChild(name)?.getChildren('jid') ?? []).map(jid => jid.text()).filter(Boolean)
  return { default: policy, always: jidList('always'), never: jidList('never') }
}
