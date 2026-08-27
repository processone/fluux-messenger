import { describe, expect, it } from 'vitest'
import type { XmppPacket } from '@fluux/sdk'
import { buildXmppConsoleExport, type XmppConsoleHealthSnapshot } from './xmppConsoleExport'

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
      recountDeferrals: {},
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
      recountDeferrals: {},
    })

    expect(output).toContain('Browser: network=unknown visibility=unknown focused=unknown')
    expect(output).toContain('Stream management: unavailable')
    expect(output).toContain('Last incoming traffic: unavailable')
    expect(output).toContain('Latest health event: unavailable')
  })
  const HEALTH: XmppConsoleHealthSnapshot = {
    status: 'online',
    machineState: { connected: 'healthy' },
    reconnectAttempt: 0,
    nextRetryDelayMs: 0,
    reconnectTargetTime: null,
    smResumeViable: true,
    displayAsleep: false,
    browserOnline: true,
    visibilityState: 'visible',
    focused: true,
    streamManagement: null,
  }

  function exportWithDeferrals(recountDeferrals: Record<string, number>): string {
    return buildXmppConsoleExport({
      entries: [],
      appVersion: '0.18.0',
      gitCommit: 'abcdef0',
      exportedAt: new Date('2026-08-18T12:00:10.000Z'),
      connectionMethod: 'websocket',
      serverInfo: null,
      health: HEALTH,
      recountDeferrals,
    })
  }

  describe('unread recount deferrals', () => {
    it('reports both scopes as none when no recount has ever deferred', () => {
      const output = exportWithDeferrals({})

      expect(output).toContain('Unread recount deferrals (cumulative)')
      expect(output).toContain('  Chat: none')
      expect(output).toContain('  Room: none')
    })

    it('keeps chat and room tallies separately readable', () => {
      const output = exportWithDeferrals({
        'chat:no-meta': 2,
        'room:coverage-missing': 7,
        'room:pointer-changed': 1,
      })

      const section = output.slice(output.indexOf('Unread recount deferrals'))
      expect(section).toContain('  Chat (2):\n    no-meta: 2')
      expect(section).toContain('  Room (8):\n    coverage-missing: 7\n    pointer-changed: 1')
    })

    it('renders one scope populated while the other stays none', () => {
      const output = exportWithDeferrals({ 'room:history-not-caught-up': 3 })

      expect(output).toContain('  Chat: none')
      expect(output).toContain('  Room (3):')
      expect(output).toContain('    history-not-caught-up: 3')
    })

    it('orders reasons by count so the dominant guard leads', () => {
      const output = exportWithDeferrals({
        'room:no-floor': 1,
        'room:coverage-short-of-floor': 9,
        'room:cache-unavailable': 4,
      })

      const section = output.slice(output.indexOf('  Room ('))
      expect(section).toContain(
        '    coverage-short-of-floor: 9\n    cache-unavailable: 4\n    no-floor: 1'
      )
    })

    it('surfaces an unrecognised scope rather than dropping its counts', () => {
      const output = exportWithDeferrals({ 'thread:no-meta': 5 })

      expect(output).toContain('  Unknown scope "thread" (5):')
      expect(output).toContain('    no-meta: 5')
    })

    it('records reasons and counts only, never conversation identifiers', () => {
      const output = exportWithDeferrals({ 'room:coverage-missing': 2 })

      const section = output.slice(output.indexOf('Unread recount deferrals'))
      expect(section).not.toContain('@')
      expect(section.split('\n').filter((line) => line.startsWith('    '))).toEqual([
        '    coverage-missing: 2',
      ])
    })
  })
})
