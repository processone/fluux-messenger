export const NS_OMEMO = 'urn:xmpp:omemo:2'
export const NS_DEVICES = 'urn:xmpp:omemo:2:devices'
export const NS_BUNDLES = 'urn:xmpp:omemo:2:bundles'
export const NS_SCE = 'urn:xmpp:sce:1'
export const devicesNode = (): string => NS_DEVICES
export const bundleNode = (deviceId: number): string => `${NS_BUNDLES}:${deviceId}`
