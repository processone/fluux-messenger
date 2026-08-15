/**
 * # Fluux SDK — raw XMPP vocabulary (escape hatch)
 *
 * Protocol namespaces, the stanza builder, and the wire parsers. Import from
 * `@fluux/sdk/xmpp`.
 *
 * The rest of the SDK is designed so that a developer never has to read a XEP:
 * conversations, rooms, contacts and presence are described in domain terms,
 * and the curated `@fluux/sdk` entry deliberately contains no namespace, no
 * stanza builder and no `Element`. This entry is where that promise stops.
 *
 * Reach for it only to speak a part of XMPP the SDK does not model yet — a
 * custom extension, an experimental XEP, a server-specific ad-hoc payload.
 * Everything here traffics in raw stanzas and assumes you know the protocol.
 *
 * An import of this module is a signal, not a defect: it marks a place where
 * the high-level API is missing something. Prefer raising that gap over
 * building on the escape hatch permanently.
 *
 * @packageDocumentation
 * @module XMPP
 */

// Stanza construction and the underlying element type (ltx, via @xmpp/client).
export { xml } from '@xmpp/client'
export type { Element } from '@xmpp/client'

// Protocol namespace constants for every XEP the SDK speaks, plus the two
// Fluux-specific nodes (NS_CONVERSATIONS, NS_FLUUX_VERIFICATIONS).
export * from '../core/namespaces'

// XEP-0060/XEP-0163: read a PEP node the SDK does not model. The nodes it does
// model — avatars, nicknames, bookmarks, read markers — reach you as domain
// state instead.
export { queryPepNode } from './pep'
export type { PEPItem } from '../core/e2ee'

// XEP-0004: Data Forms — read and submit a form carried in a stanza.
// The `DataForm` shapes themselves stay on the main entry: an app renders
// admin forms without ever touching the wire.
export { parseDataForm, getFormFieldValue, getFormFieldValues, buildDataFormSubmit } from '../utils/dataForm'

// XEP-0059: Result Set Management — pagination on the wire. The `RSMRequest`
// and `RSMResponse` shapes stay on the main entry for the same reason.
export { parseRSMResponse, buildRSMElement } from '../utils/rsm'

// XEP-0066: Out of Band Data. A URL and a description, as the extension puts
// them on the wire. An attachment the SDK models is a `FileAttachment` on the
// main entry; this is for reading or writing the raw element.
export type { OobInfo } from '../core/types/upload'

// XEP-0428: Fallback Indication — strip the fallback text a sending client
// wrote for clients that cannot render the real payload.
export { processFallback, getFallbackElement } from '../utils/fallbackUtils'
export type { FallbackProcessingResult, FallbackProcessingOptions } from '../utils/fallbackUtils'

// RFC 6120: parse a stanza `<error/>` into a structured value. Formatting one
// for a human (`formatXMPPError`) stays on the main entry — by then the error
// is an ordinary field of a message, not a piece of XML.
export { parseXMPPError } from '../utils/xmppError'
