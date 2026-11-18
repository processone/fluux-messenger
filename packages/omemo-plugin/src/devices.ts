// Entry `@fluux/omemo-plugin/devices`: the account's own OMEMO device lists, readable and editable with no plugin
// registered and without loading the OMEMO crypto.
import type { XMPPClient } from '@fluux/sdk/core'
import { queryPepNode, publishPepNode } from '@fluux/sdk/xmpp'
import type { OwnPepAccess } from './deviceLists'

export { readOwnDeviceLists, removeOwnDevices } from './deviceLists'
export type {
  DeviceListProtocol,
  DeviceListRead,
  OwnDevice,
  OwnDeviceLists,
  OwnPepAccess,
  RemoveResult,
} from './deviceLists'

/** Reads and writes the account's own PEP through a connected client, with no plugin registered. */
export function pepAccessFor(client: XMPPClient): OwnPepAccess {
  return {
    query: (jid, node, maxItems) => queryPepNode(client, jid, node, maxItems),
    publish: (node, item, options) => publishPepNode(client, node, item, options),
  }
}
