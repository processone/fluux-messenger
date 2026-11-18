export const NS_OMEMO = 'urn:xmpp:omemo:2'
export const NS_DEVICES = 'urn:xmpp:omemo:2:devices'
export const NS_BUNDLES = 'urn:xmpp:omemo:2:bundles'
export const NS_SCE = 'urn:xmpp:sce:1'
export const devicesNode = (): string => NS_DEVICES
/** XEP-0384: one shared bundles node; each device's bundle is the item whose id is its device id. */
export const bundlesNode = (): string => NS_BUNDLES

/** Legacy OMEMO (XEP-0384 0.3, `eu.siacs.conversations.axolotl`), still the only list many clients publish. */
export const NS_LEGACY_OMEMO = 'eu.siacs.conversations.axolotl'
export const NS_LEGACY_DEVICELIST = 'eu.siacs.conversations.axolotl.devicelist'
/** Legacy OMEMO bundles live one node per device: this prefix followed by the device id. */
export const NS_LEGACY_BUNDLES_PREFIX = 'eu.siacs.conversations.axolotl.bundles:'
