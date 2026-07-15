/**
 * Unit tests for the EME namespace -> plugin id map used to decide whether
 * an inbound `<encrypted>` stanza is "supported" (a matching plugin is
 * registered) vs "unsupported" (no plugin claims the protocol). Covers the
 * `urn:xmpp:omemo:2` addition so OMEMO 2 stanzas are recognized once the
 * `omemo:2` plugin is registered, instead of falling through to the
 * "unsupported method" UI path.
 */
import { describe, it, expect } from 'vitest'
import { emePluginIdFor } from './stanzaDecrypt'

describe('emePluginIdFor', () => {
  it('maps the OMEMO 2 EME namespace to the omemo:2 plugin id', () => {
    expect(emePluginIdFor('urn:xmpp:omemo:2')).toBe('omemo:2')
  })

  it('maps the OpenPGP EME namespace to the openpgp plugin id', () => {
    expect(emePluginIdFor('urn:xmpp:openpgp:0')).toBe('openpgp')
  })

  it('returns undefined for a namespace with no registered plugin id', () => {
    expect(emePluginIdFor('urn:xmpp:unknown')).toBeUndefined()
  })
})
