import { format } from 'date-fns'
import type {
  ConnectionMethod,
  ConnectionStateValue,
  ConnectionStatus,
  ServerInfo,
  XmppPacket,
} from '@fluux/sdk'

export interface XmppConsoleHealthSnapshot {
  status: ConnectionStatus
  machineState: ConnectionStateValue
  reconnectAttempt: number
  nextRetryDelayMs: number
  reconnectTargetTime: number | null
  smResumeViable: boolean
  displayAsleep: boolean
  browserOnline: boolean | null
  visibilityState: string | null
  focused: boolean | null
  streamManagement: { inbound: number; outbound: number } | null
}

interface XmppConsoleExportOptions {
  entries: XmppPacket[]
  appVersion: string
  gitCommit: string
  exportedAt: Date
  connectionMethod: ConnectionMethod | null
  serverInfo: ServerInfo | null
  health: XmppConsoleHealthSnapshot
}

function formatMachineState(state: ConnectionStateValue): string {
  if (typeof state === 'string') return state
  const [parent, child] = Object.entries(state)[0] ?? ['unknown', 'unknown']
  return `${parent}.${child}`
}

function formatOptionalBoolean(value: boolean | null): string {
  return value === null ? 'unknown' : String(value)
}

function formatTraffic(
  entries: XmppPacket[],
  direction: 'incoming' | 'outgoing',
  exportedAt: Date
): string {
  const entry = findLastEntry(entries, (candidate) => candidate.type === direction)
  if (!entry) return 'unavailable'
  const ageMs = Math.max(0, exportedAt.getTime() - entry.timestamp.getTime())
  return `${entry.timestamp.toISOString()} (ageMs=${ageMs})`
}

function findLastEntry(
  entries: XmppPacket[],
  predicate: (entry: XmppPacket) => boolean
): XmppPacket | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index])) return entries[index]
  }
  return undefined
}

function buildHealthSection(
  entries: XmppPacket[],
  health: XmppConsoleHealthSnapshot,
  exportedAt: Date
): string[] {
  const latestHealthEvent = findLastEntry(
    entries,
    (entry) => entry.type === 'event' && entry.content.startsWith('[health] ')
  )
  const latestSmAck = findLastEntry(
    entries,
    (entry) => entry.type === 'incoming' &&
      /^<a(?:\s|>)/.test(entry.content.trim()) &&
      entry.content.includes('urn:xmpp:sm:3')
  )
  const reconnectTarget = health.reconnectTargetTime === null
    ? 'none'
    : new Date(health.reconnectTargetTime).toISOString()

  return [
    '',
    'Connection health',
    `  Store status: ${health.status}`,
    `  Machine state: ${formatMachineState(health.machineState)}`,
    `  Reconnect: attempt=${health.reconnectAttempt} nextRetryDelayMs=${health.nextRetryDelayMs} target=${reconnectTarget}`,
    `  Resume policy: smResumeViable=${health.smResumeViable} displayAsleep=${health.displayAsleep}`,
    `  Browser: network=${health.browserOnline === null ? 'unknown' : health.browserOnline ? 'online' : 'offline'} visibility=${health.visibilityState ?? 'unknown'} focused=${formatOptionalBoolean(health.focused)}`,
    health.streamManagement
      ? `  Stream management: inbound=${health.streamManagement.inbound} outbound=${health.streamManagement.outbound}`
      : '  Stream management: unavailable',
    latestSmAck
      ? `  Last SM acknowledgment: ${latestSmAck.timestamp.toISOString()} (ageMs=${Math.max(0, exportedAt.getTime() - latestSmAck.timestamp.getTime())})`
      : '  Last SM acknowledgment: unavailable',
    `  Last incoming traffic: ${formatTraffic(entries, 'incoming', exportedAt)}`,
    `  Last outgoing traffic: ${formatTraffic(entries, 'outgoing', exportedAt)}`,
    latestHealthEvent
      ? `  Latest health event: ${latestHealthEvent.timestamp.toISOString()} ${latestHealthEvent.content}`
      : '  Latest health event: unavailable',
    '',
    '================================================================================',
  ]
}

export function buildXmppConsoleExport(options: XmppConsoleExportOptions): string {
  const {
    entries,
    appVersion,
    gitCommit,
    exportedAt,
    connectionMethod,
    serverInfo,
    health,
  } = options
  const header = [
    '================================================================================',
    'Fluux XMPP Console Log',
    `Version: ${appVersion} (${gitCommit})`,
    `Connection: ${connectionMethod?.toUpperCase() ?? 'Unknown'}`,
    `Exported: ${format(exportedAt, 'yyyy-MM-dd HH:mm:ss')}`,
    '================================================================================',
  ]

  const serverSection: string[] = []
  if (serverInfo) {
    serverSection.push('')
    serverSection.push(`Server: ${serverInfo.domain}`)
    if (serverInfo.identities.length > 0) {
      const identity = serverInfo.identities[0]
      serverSection.push(`Identity: ${identity.name || 'Unknown'} (${identity.category}/${identity.type})`)
    }
    serverSection.push(`Features (${serverInfo.features.length}):`)
    for (const feature of serverInfo.features) {
      serverSection.push(`  - ${feature}`)
    }
  }

  const lines = entries.map((entry) => {
    const timestamp = format(entry.timestamp, 'yyyy-MM-dd HH:mm:ss.SSS')
    if (entry.type === 'event') {
      return `[${timestamp}] EVENT: ${entry.content}`
    }
    const direction = entry.type === 'incoming' ? 'IN ' : 'OUT'
    return `[${timestamp}] ${direction}: ${entry.content}`
  })

  return [
    ...header,
    ...serverSection,
    ...buildHealthSection(entries, health, exportedAt),
    '',
    ...lines,
  ].join('\n')
}
