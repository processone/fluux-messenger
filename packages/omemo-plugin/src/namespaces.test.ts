import { describe, it, expect } from 'vitest'
import { NS_OMEMO, NS_DEVICES, NS_SCE, devicesNode, bundleNode } from './namespaces'

describe('namespaces', () => {
  it('has the exact OMEMO 2 / SCE strings', () => {
    expect(NS_OMEMO).toBe('urn:xmpp:omemo:2')
    expect(NS_DEVICES).toBe('urn:xmpp:omemo:2:devices')
    expect(NS_SCE).toBe('urn:xmpp:sce:1')
    expect(devicesNode()).toBe('urn:xmpp:omemo:2:devices')
    expect(bundleNode(42)).toBe('urn:xmpp:omemo:2:bundles:42')
  })
})
