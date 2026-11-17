/** Shared XEP-0373 protocol descriptor. */

import type { E2EEProtocolDescriptor } from '@fluux/sdk'

const OX_IM_FEATURE = 'urn:xmpp:openpgp:im:0'

export const OPENPGP_DESCRIPTOR: E2EEProtocolDescriptor = {
  id: 'openpgp',
  displayName: 'OpenPGP (XEP-0373)',
  securityLevel: 30,
  discoFeatures: [OX_IM_FEATURE],
  features: {
    forwardSecrecy: false,
    postCompromiseSecurity: false,
    multiDevice: true,
    groupChat: false,
    asynchronous: true,
    deniability: false,
  },
}
