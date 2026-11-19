import { CONFERENCE, DOMAIN } from '../constants'

/**
 * The account keeps the default demo JID: the demo OpenPGP plugin and the E2EE
 * manager are bound to it, and to `ava@` as the one encryption-capable peer.
 */
export const SHOWCASE_SELF_NAME = 'Daniel Moss'
export const SHOWCASE_SELF_NICK = 'Daniel'

export const ASSETS = './demo/showcase'

export const EMMA = `emma@${DOMAIN}`
export const AVA = `ava@${DOMAIN}`
export const LIAM = `liam@${DOMAIN}`
export const SOPHIA = `sophia@${DOMAIN}`
export const JAMES = `james@${DOMAIN}`
export const OLIVIA = `olivia@${DOMAIN}`

export const LAUNCH_ROOM = `launch@${CONFERENCE}`
export const DESIGN_ROOM = `design-studio@${CONFERENCE}`
export const COMMUNITY_ROOM = `community@${CONFERENCE}`
