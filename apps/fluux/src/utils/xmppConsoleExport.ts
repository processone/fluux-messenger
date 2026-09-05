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
  /**
   * Session unread-recount deferral tallies, keyed `<kind>:<reason>`, exactly as
   * the app's `readRecountDeferrals()` returns them.
   *
   * Read-only input: the export renders these and nothing feeds them back into any
   * decision. The tallies carry reasons and counts only — never an entity id,
   * message id or unread total — so nothing here can identify a conversation.
   */
  recountDeferrals: Record<string, number>
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
  ]
}

/** Scopes rendered in a fixed order so two exports can be compared line by line. */
const RECOUNT_SCOPES: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: 'chat', label: 'Chat' },
  { prefix: 'room', label: 'Room' },
]

function scopeOf(key: string): string {
  const separator = key.indexOf(':')
  return separator === -1 ? '' : key.slice(0, separator)
}

function reasonOf(key: string): string {
  const separator = key.indexOf(':')
  return separator === -1 ? key : key.slice(separator + 1)
}

/**
 * One scope's tallies, heaviest first so the dominant reason leads.
 *
 * The app's `readRecountDeferrals()` only holds keys that were actually incremented,
 * so a zero-count reason never reaches here and the list stays free of noise.
 */
function formatScopeTallies(
  deferrals: Record<string, number>,
  prefix: string,
  label: string
): string[] {
  const entries = Object.entries(deferrals)
    .filter(([key]) => scopeOf(key) === prefix)
    .sort(([leftKey, left], [rightKey, right]) =>
      right - left || reasonOf(leftKey).localeCompare(reasonOf(rightKey))
    )

  if (entries.length === 0) return [`  ${label}: none`]

  const total = entries.reduce((sum, [, count]) => sum + count, 0)
  return [
    `  ${label} (${total}):`,
    ...entries.map(([key, count]) => `    ${reasonOf(key)}: ${count}`),
  ]
}

/**
 * Why unread badges kept their value, as reasons and counts.
 *
 * The tallies accumulate in every build, including release; only the anomaly
 * digest's reader is eliminated from production. Rendering them here is what lets a
 * field report from a shipped build say which guard stood down, and how often, for a
 * chat as opposed to a room.
 *
 * A healthy session defers nothing, so an empty tally set is the normal case and
 * renders as an explicit `none` per scope rather than a missing or alarming section.
 */
function buildRecountDeferralSection(deferrals: Record<string, number>): string[] {
  const knownPrefixes = new Set(RECOUNT_SCOPES.map((scope) => scope.prefix))
  // A scope this build has no label for means the SDK grew one; show it rather than
  // silently dropping counts a bug report may depend on.
  const unknownScopes = [...new Set(Object.keys(deferrals).map(scopeOf))]
    .filter((prefix) => !knownPrefixes.has(prefix))
    .sort()

  return [
    '',
    'Unread recount deferrals (cumulative)',
    ...RECOUNT_SCOPES.flatMap((scope) =>
      formatScopeTallies(deferrals, scope.prefix, scope.label)
    ),
    ...unknownScopes.flatMap((prefix) =>
      formatScopeTallies(deferrals, prefix, `Unknown scope "${prefix}"`)
    ),
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
    recountDeferrals,
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
    ...buildRecountDeferralSection(recountDeferrals),
    '',
    '================================================================================',
    '',
    ...lines,
  ].join('\n')
}
