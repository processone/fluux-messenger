import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getDomain } from '../jid'
import { generateUUID } from '../../utils/uuid'
import {
  NS_DISCO_INFO,
  NS_DISCO_ITEMS,
  NS_HTTP_UPLOAD,
  NS_MAM,
  NS_CARBONS,
  NS_BLOCKING,
  NS_PUBSUB,
} from '../namespaces'
import type { UploadSlot, HttpUploadService } from '../types'
import { logInfo, logWarn } from '../logger'

/**
 * Service discovery and HTTP file upload module.
 *
 * Handles server capability discovery and file upload service:
 * - XEP-0030: Service Discovery (disco#info, disco#items)
 * - XEP-0363: HTTP File Upload (service discovery, upload slot requests)
 *
 * @remarks
 * Server features are discovered on connection and stored in the connection
 * store. HTTP upload service is discovered separately via disco#items.
 *
 * @example
 * ```typescript
 * // Access via XMPPClient
 * client.discovery.fetchServerInfo()
 * client.discovery.discoverHttpUploadService()
 *
 * // Request upload slot for file sharing
 * const slot = await client.discovery.requestUploadSlot('photo.jpg', 1024000, 'image/jpeg')
 * // PUT file to slot.putUrl, then share slot.getUrl in message
 * ```
 *
 * @category Modules
 */
export class Discovery extends BaseModule {
  handle(_stanza: Element): boolean | void {
    // Discovery doesn't handle incoming stanzas (responses handled via IQ caller)
    return false
  }

  /**
   * Fetch server features via disco#info (XEP-0030).
   * Queries the server domain to discover supported features and identities.
   */
  async fetchServerInfo(): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return

    // Query the server domain (bare domain, not full JID)
    const domain = getDomain(currentJid)
    if (!domain) return

    const iq = xml(
      'iq',
      { type: 'get', to: domain, id: `disco_${generateUUID()}` },
      xml('query', { xmlns: NS_DISCO_INFO })
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const query = result.getChild('query', NS_DISCO_INFO)
      if (!query) return

      // Parse identities
      const identities = query.getChildren('identity').map((identity: Element) => ({
        category: identity.attrs.category || '',
        type: identity.attrs.type || '',
        name: identity.attrs.name,
      }))

      // Parse features
      const features = query.getChildren('feature')
        .map((feature: Element) => feature.attrs.var as string)
        .filter(Boolean)
        .sort()

      // Emit SDK event for server info
      const serverInfo = { domain, identities, features }
      this.deps.emitSDK('connection:server-info', { info: serverInfo })

      // Log server identity (e.g. "server/im ejabberd 24.06")
      const primaryIdentity = identities.find(i => i.category === 'server')
      if (primaryIdentity) {
        const idName = primaryIdentity.name ? ` "${primaryIdentity.name}"` : ''
        logInfo(`Server identity: ${primaryIdentity.category}/${primaryIdentity.type}${idName}`)
      }

      // Log key feature flags for troubleshooting
      const keyFeatures = {
        MAM: features.includes(NS_MAM),
        Carbons: features.includes(NS_CARBONS),
        Blocking: features.includes(NS_BLOCKING),
        PubSub: features.some(f => f.startsWith(NS_PUBSUB)),
      }
      const featureSummary = Object.entries(keyFeatures)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      logInfo(`Server features (${features.length}): ${featureSummary}`)

      this.deps.emitSDK('console:event', {
        message: `Server ${domain}: ${features.length} features discovered`,
        category: 'connection',
      })
    } catch (err) {
      // Server disco#info not available - that's fine, not all servers support it
      logWarn(`Server disco#info failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Discover HTTP Upload service (XEP-0363).
   * First checks disco#info directly on server domain (some servers like Prosody
   * advertise the feature there), then falls back to querying disco#items.
   */
  async discoverHttpUploadService(): Promise<void> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return

    const domain = getDomain(currentJid)
    if (!domain) return

    try {
      // 1. First check disco#info directly on server domain
      // Some servers (e.g., Prosody with http_file_share) advertise the upload
      // feature directly on the server rather than as a separate component
      const serverInfoIq = xml(
        'iq',
        { type: 'get', to: domain, id: `info_${generateUUID()}` },
        xml('query', { xmlns: NS_DISCO_INFO })
      )
      const serverInfoResult = await this.deps.sendIQ(serverInfoIq)
      const serverQuery = serverInfoResult.getChild('query', NS_DISCO_INFO)
      const serverFeatures = serverQuery?.getChildren('feature') || []
      const serverHasUpload = serverFeatures.some((f: Element) => f.attrs.var === NS_HTTP_UPLOAD)

      if (serverHasUpload) {
        const uploadService = this.extractUploadService(domain, serverQuery)
        this.deps.emitSDK('connection:http-upload-service', { service: uploadService })
        logInfo(`HTTP Upload service: ${domain}${uploadService.maxFileSize ? ` (max ${Math.round(uploadService.maxFileSize / 1024 / 1024)}MB)` : ''}`)
        this.deps.emitSDK('console:event', {
          message: `HTTP Upload service discovered on server: ${domain}${uploadService.maxFileSize ? ` (max ${Math.round(uploadService.maxFileSize / 1024 / 1024)}MB)` : ''}`,
          category: 'connection',
        })
        return
      }

      // 2. Query disco#items on server domain to find upload component
      const itemsIq = xml(
        'iq',
        { type: 'get', to: domain, id: `items_${generateUUID()}` },
        xml('query', { xmlns: NS_DISCO_ITEMS })
      )
      const itemsResult = await this.deps.sendIQ(itemsIq)

      // 3. For each item, query disco#info to find HTTP Upload feature
      const items = itemsResult.getChild('query', NS_DISCO_ITEMS)?.getChildren('item') || []
      logInfo(`Disco#items: ${items.length} component(s) on ${domain}`)

      for (const item of items) {
        const itemJid = item.attrs.jid
        if (!itemJid) continue

        try {
          const infoIq = xml(
            'iq',
            { type: 'get', to: itemJid, id: `info_${generateUUID()}` },
            xml('query', { xmlns: NS_DISCO_INFO })
          )
          const infoResult = await this.deps.sendIQ(infoIq)

          // Check for HTTP Upload feature
          const query = infoResult.getChild('query', NS_DISCO_INFO)
          const features = query?.getChildren('feature') || []
          const hasUpload = features.some((f: Element) => f.attrs.var === NS_HTTP_UPLOAD)

          if (hasUpload) {
            const uploadService = this.extractUploadService(itemJid, query)
            this.deps.emitSDK('connection:http-upload-service', { service: uploadService })
            logInfo(`HTTP Upload service: ${itemJid}${uploadService.maxFileSize ? ` (max ${Math.round(uploadService.maxFileSize / 1024 / 1024)}MB)` : ''}`)
            this.deps.emitSDK('console:event', {
              message: `HTTP Upload service discovered: ${itemJid}${uploadService.maxFileSize ? ` (max ${Math.round(uploadService.maxFileSize / 1024 / 1024)}MB)` : ''}`,
              category: 'connection',
            })
            return
          }
        } catch {
          // Failed to query this item, continue to next
        }
      }

      // No HTTP Upload service found
      logInfo('No HTTP Upload service found')
      this.deps.emitSDK('connection:http-upload-service', { service: null })
    } catch (err) {
      // disco#info/items not available
      logWarn(`HTTP Upload discovery failed: ${err instanceof Error ? err.message : String(err)}`)
      this.deps.emitSDK('connection:http-upload-service', { service: null })
    }
  }

  /**
   * Extract HTTP Upload service info from a disco#info query result.
   * @param jid - The JID of the service
   * @param query - The query element from disco#info response
   * @returns HttpUploadService with jid and optional maxFileSize
   */
  private extractUploadService(jid: string, query: Element | undefined): HttpUploadService {
    let maxFileSize: number | undefined

    // Extract max-file-size from x-data form if present
    const xForm = query?.getChild('x', 'jabber:x:data')
    if (xForm) {
      const fields = xForm.getChildren('field') || []
      for (const field of fields) {
        if (field.attrs.var === 'max-file-size') {
          const value = field.getChildText('value')
          if (value) {
            maxFileSize = parseInt(value, 10)
          }
          break
        }
      }
    }

    return { jid, maxFileSize }
  }

  /**
   * Request an upload slot from the HTTP Upload service (XEP-0363).
   * @param filename - Name of the file to upload
   * @param size - Size of the file in bytes
   * @param contentType - MIME type of the file
   * @returns Upload slot with PUT and GET URLs
   */
  async requestUploadSlot(filename: string, size: number, contentType: string): Promise<UploadSlot> {
    if (!this.deps.getXmpp()) {
      throw new Error('Not connected')
    }

    const service = this.deps.stores?.connection.getHttpUploadService?.()
    if (!service) {
      throw new Error('HTTP Upload service not available')
    }

    // Check file size limit
    if (service.maxFileSize && size > service.maxFileSize) {
      throw new Error(`File too large (max ${Math.round(service.maxFileSize / 1024 / 1024)}MB)`)
    }

    const iq = xml(
      'iq',
      { type: 'get', to: service.jid, id: `slot_${generateUUID()}` },
      xml('request', {
        xmlns: NS_HTTP_UPLOAD,
        filename,
        size: String(size),
        'content-type': contentType,
      })
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const slot = result.getChild('slot', NS_HTTP_UPLOAD)
      const put = slot?.getChild('put')
      const get = slot?.getChild('get')

      if (!put?.attrs.url || !get?.attrs.url) {
        throw new Error('Invalid upload slot response')
      }

      // Extract headers from put element
      const headers: Record<string, string> = {}
      const headerElements = put.getChildren('header') || []
      for (const h of headerElements) {
        if (h.attrs.name) {
          headers[h.attrs.name] = h.text() || ''
        }
      }

      return {
        putUrl: put.attrs.url,
        getUrl: get.attrs.url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      }
    } catch (err) {
      if (err instanceof Error) {
        throw err
      }
      throw new Error('Failed to request upload slot')
    }
  }
}
