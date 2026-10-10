import { xml, type Element } from '@xmpp/client'
import type { FileAttachment, FileEncryption } from '../types'
import { NS_OOB, NS_THUMBS, NS_FALLBACK, NS_FILE_METADATA } from '../namespaces'
import { toCodePointOffset } from '../../utils/xep0426'

/** Shared XEP-0066, XEP-0428 and XEP-0446 attachment payload for public and private sends. */
export function attachmentElements(
  attachment: FileAttachment,
  fullBody: string,
  fallbackStart: number,
  fallbackEnd: number,
  wireUrl: (url: string, encryption?: FileEncryption) => string = url => url,
): Element[] {
  const elements: Element[] = []
  const oobUrl = wireUrl(attachment.url, attachment.encryption)
  const oobChildren = [xml('url', {}, oobUrl)]
  if (attachment.thumbnail) {
    const thumbUri = wireUrl(
      attachment.thumbnail.uri,
      attachment.thumbnail.encryption,
    )
    oobChildren.push(xml('thumbnail', {
      xmlns: NS_THUMBS,
      uri: thumbUri,
      'media-type': attachment.thumbnail.mediaType,
      width: String(attachment.thumbnail.width),
      height: String(attachment.thumbnail.height),
    }))
  }
  elements.push(xml('x', { xmlns: NS_OOB }, ...oobChildren))
  // Mark only the URL portion as fallback (preserves user text)
  elements.push(xml('fallback', { xmlns: NS_FALLBACK, for: NS_OOB },
    xml('body', {
      start: String(toCodePointOffset(fullBody, fallbackStart)),
      end: String(toCodePointOffset(fullBody, fallbackEnd)),
    })
  ))

  // XEP-0446: File Metadata Element (for original dimensions)
  const fileChildren: Element[] = []
  if (attachment.mediaType) {
    fileChildren.push(xml('media-type', {}, attachment.mediaType))
  }
  if (attachment.name) {
    fileChildren.push(xml('name', {}, attachment.name))
  }
  if (attachment.size !== undefined) {
    fileChildren.push(xml('size', {}, String(attachment.size)))
  }
  if (attachment.width !== undefined) {
    fileChildren.push(xml('width', {}, String(attachment.width)))
  }
  if (attachment.height !== undefined) {
    fileChildren.push(xml('height', {}, String(attachment.height)))
  }
  if (fileChildren.length > 0) {
    elements.push(xml('file', { xmlns: NS_FILE_METADATA }, ...fileChildren))
  }
  return elements
}
