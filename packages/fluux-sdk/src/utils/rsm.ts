import { xml, Element } from '@xmpp/client'
import type { PageRequest, PageInfo } from '../core/types'
import { NS_RSM } from '../core/namespaces'

/**
 * Parse RSM response from XML element (XEP-0059).
 */
export function parseRSMResponse(setElement: Element | undefined): PageInfo {
  if (!setElement) return {}

  const response: PageInfo = {}

  const firstEl = setElement.getChild('first')
  if (firstEl) {
    response.first = firstEl.getText() || undefined
    const indexAttr = firstEl.attrs.index
    if (indexAttr !== undefined) {
      response.firstIndex = parseInt(indexAttr, 10)
    }
  }

  const lastEl = setElement.getChild('last')
  if (lastEl) {
    response.last = lastEl.getText() || undefined
  }

  const countEl = setElement.getChild('count')
  if (countEl) {
    const countText = countEl.getText()
    if (countText) {
      response.count = parseInt(countText, 10)
    }
  }

  return response
}

/**
 * Build RSM request XML element (XEP-0059).
 */
export function buildRSMElement(page: PageRequest): Element {
  const children: Element[] = []

  if (page.max !== undefined) {
    children.push(xml('max', {}, String(page.max)))
  }

  if (page.after !== undefined) {
    children.push(xml('after', {}, page.after))
  }

  if (page.before !== undefined) {
    children.push(xml('before', {}, page.before))
  }

  if (page.index !== undefined) {
    children.push(xml('index', {}, String(page.index)))
  }

  return xml('set', { xmlns: NS_RSM }, ...children)
}
