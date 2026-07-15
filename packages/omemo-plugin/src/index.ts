// Public surface of `@fluux/omemo-plugin`: the `OmemoPlugin` adapter plus the
// OMEMO/SCE namespace constants and PEP node helpers. Internal modules (sce,
// encryptedElement, pep, store, trust, stanzaData) and the `testing/` mock host
// are intentionally NOT re-exported — they are implementation detail.
export { OmemoPlugin } from './OmemoPlugin'
export { NS_OMEMO, NS_DEVICES, NS_BUNDLES, NS_SCE, devicesNode, bundleNode } from './namespaces'
