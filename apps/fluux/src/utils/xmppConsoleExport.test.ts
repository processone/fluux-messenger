import { describe, expect, it } from 'vitest'
import type { XmppPacket } from '@fluux/sdk'
import { buildXmppConsoleExport } from './xmppConsoleExport'

describe('buildXmppConsoleExport', () => {
  it('includes a privacy-safe connection health snapshot and recent traffic', () => {
    const exportedAt = new Date('2026-08-18T12:00:10.000Z')
    const entries: XmppPacket[] = [
      {
        id: 'outgoing',
        type: 'outgoing',
        content: '<r xmlns="urn:xmpp:sm:3"/>',
        timestamp: new Date('2026-08-18T12:00:04.000Z'),
      },
      {
        id: 'incoming',
        type: 'incoming',
        content: '<a xmlns="urn:xmpp:sm:3" h="42"/>',
        timestamp: new Date('2026-08-18T12:00:06.500Z'),
      },
      {
        id: 'health',
        type: 'event',
        content: '[health] probe-recovered generation=3 mode=sm-ack elapsedMs=275 lastSmAckAgeMs=0 bufferedAmount=0',
        eventCategory: 'connection',
        timestamp: new Date('2026-08-18T12:00:06.500Z'),
      },
    ]

    const output = buildXmppConsoleExport({
      entries,
      appVersion: '0.18.0',
      gitCommit: 'abcdef0',
      exportedAt,
      connectionMethod: 'websocket',
      serverInfo: null,
      health: {
        status: 'online',
        machineState: { connected: 'healthy' },
        reconnectAttempt: 0,
        nextRetryDelayMs: 0,
        reconnectTargetTime: null,
        smResumeViable: true,
        displayAsleep: false,
        browserOnline: true,
        visibilityState: 'hidden',
        focused: false,
        streamManagement: { inbound: 42, outbound: 39 },
      },
    })

    expect(output).toContain('Connection health')
    expect(output).toContain('Store status: online')
    expect(output).toContain('Machine state: connected.healthy')
    expect(output).toContain('Reconnect: attempt=0 nextRetryDelayMs=0 target=none')
    expect(output).toContain('Stream management: inbound=42 outbound=39')
    expect(output).toContain('Last SM acknowledgment: 2026-08-18T12:00:06.500Z (ageMs=3500)')
    expect(output).toContain('Browser: network=online visibility=hidden focused=false')
    expect(output).toContain('Last outgoing traffic: 2026-08-18T12:00:04.000Z (ageMs=6000)')
    expect(output).toContain('Last incoming traffic: 2026-08-18T12:00:06.500Z (ageMs=3500)')
    expect(output).toContain('Latest health event: 2026-08-18T12:00:06.500Z [health] probe-recovered')
    expect(output).not.toContain('sm-session-secret')
  })

  it('uses explicit unavailable markers when runtime signals do not exist', () => {
    const output = buildXmppConsoleExport({
      entries: [],
      appVersion: '0.18.0',
      gitCommit: 'abcdef0',
      exportedAt: new Date('2026-08-18T12:00:10.000Z'),
      connectionMethod: null,
      serverInfo: null,
      health: {
        status: 'disconnected',
        machineState: 'disconnected',
        reconnectAttempt: 0,
        nextRetryDelayMs: 0,
        reconnectTargetTime: null,
        smResumeViable: true,
        displayAsleep: false,
        browserOnline: null,
        visibilityState: null,
        focused: null,
        streamManagement: null,
      },
    })

    expect(output).toContain('Browser: network=unknown visibility=unknown focused=unknown')
    expect(output).toContain('Stream management: unavailable')
    expect(output).toContain('Last incoming traffic: unavailable')
    expect(output).toContain('Latest health event: unavailable')
  })
})
