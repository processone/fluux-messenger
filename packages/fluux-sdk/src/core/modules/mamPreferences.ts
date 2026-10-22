/**
 * XEP-0441 archiving preferences (formerly XEP-0313 §6): stanza building and parsing.
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
 * prefs element, no recognised `default` policy, or malformed exception lists.
 */
export function parsePreferences(result: Element): ArchivingPreferences | null {
  const prefs = result.getChild('prefs', NS_MAM)
  const policy = prefs?.attrs.default
  if (!prefs || !isArchivingDefault(policy)) return null
  const jidList = (name: 'always' | 'never') => {
    const lists = prefs.getChildren(name)
    if (lists.length !== 1) return null
    const jids = lists[0].getChildren('jid').map(jid => jid.text())
    // Never silently discard an exception from a malformed response before a SET.
    return jids.every(jid => jid.trim().length > 0) ? jids : null
  }
  const always = jidList('always')
  const never = jidList('never')
  return always && never ? { default: policy, always, never } : null
}
