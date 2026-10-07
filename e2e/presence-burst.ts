import { expect, test as base } from '@playwright/test'
import { buildSync } from 'esbuild'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { XMPPClient } from '@fluux/sdk/core'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'

const parserBundle = buildSync({
  stdin: { contents: "import { Parser } from '@xmpp/xml'; window.__presenceParser = Parser", resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', platform: 'browser',
}).outputFiles[0].text
const roomJid = 'team@conference.fluux.chat'

const test = base.extend<{ presenceSocket: string }>({
  presenceSocket: async ({}, use) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => server.once('listening', resolve))
    server.on('connection', socket => {
      socket.once('message', async message => {
        const { spacing, singleFrame } = JSON.parse(message.toString()) as { spacing: number; singleFrame: boolean }
        const presences: string[] = []
        for (let i = 0; i < 200; i++) {
          for (const show of ['away', 'chat']) {
            presences.push(`<presence from="${roomJid}/Burst${i}"><show>${show}</show><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="member" role="participant"/></x><occupant-id xmlns="urn:xmpp:occupant-id:0" id="burst-${i}"/></presence>`)
          }
        }
        // One message keeps all parser callbacks in one browser task, so a
        // coalescing timer cannot split the burst according to network scheduling.
        if (singleFrame) socket.send(presences.join(''))
        else {
          for (const presence of presences) {
            socket.send(presence)
            if (spacing) await new Promise(resolve => setTimeout(resolve, spacing))
          }
        }
        socket.send('END')
      })
    })
    try { await use(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`) }
    finally {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  },
})

type PresenceLab = Window & {
  __demoClient: XMPPClient
  __roomStore: typeof roomStore
  __presenceParser: new () => {
    write(data: string): void
    on(event: 'error', handler: (error: Error) => void): void
    on(event: 'element', handler: (stanza: Parameters<XMPPClient['rooms']['handle']>[0]) => void): void
  }
}

for (const membersOpen of [false, true]) {
  for (const { spacingMs, singleFrame } of [
    { spacingMs: 0, singleFrame: true },
    { spacingMs: 0, singleFrame: false },
    { spacingMs: 17, singleFrame: false },
  ]) {
    test(`400 presences at ${spacingMs}ms with members ${membersOpen ? 'open' : 'closed'}${!spacingMs && !singleFrame ? ' (separate frames)' : ''}`, async ({ page, presenceSocket }) => {
      const errors: string[] = []
      // This spec-defined notice reports deferred resize observations. Presence
      // outcomes are checked below; every other intake error remains fatal.
      // https://drafts.csswg.org/resize-observer/#deliver-resize-loop-error
      const recordError = (message: string) => {
        if (message !== 'ResizeObserver loop completed with undelivered notifications.') errors.push(message)
      }
      page.on('pageerror', error => recordError(error.message))
      page.on('console', message => { if (message.type() === 'error') recordError(message.text()) })
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.addScriptTag({ content: parserBundle })
      await page.evaluate(jid => {
        const w = window as unknown as PresenceLab
        const store = w.__roomStore.getState()
        const occupants = Array.from({ length: 200 }, (_, i) => ({
          nick: `Burst${i}`, occupantId: `burst-${i}`, role: 'participant' as const, affiliation: 'member' as const, show: 'chat' as const,
        }))
        store.batchAddOccupants(jid, occupants)
        store.activateRoom(jid)
        window.location.hash = '#/rooms/' + encodeURIComponent(jid)
      }, roomJid)
      await page.getByRole('button', { name: /(?:Show|Hide) members/ }).waitFor()
      const toggle = page.getByRole('button', { name: /(?:Show|Hide) members/ })
      if ((await toggle.getAttribute('aria-label')) === (membersOpen ? 'Show members' : 'Hide members')) await toggle.click()
      await expect(toggle).toHaveAttribute('aria-label', membersOpen ? 'Hide members' : 'Show members')
      await page.waitForTimeout(100)
      // WebKit rejects the demo's automatic notification prompt without a user gesture.
      const bootErrors = errors.splice(0)
      expect(bootErrors.filter(error => error !== 'Notification prompting can only be done from a user gesture.')).toEqual([])

      const result = await page.evaluate(async ({ jid, spacing, singleFrame, url }) => {
        const w = window as unknown as PresenceLab
        const parser = new w.__presenceParser()
        const parserErrors: string[] = []
        let parsed = 0
        const delivered: string[] = []
        let notifications = 0
        const applied: string[] = []
        const expected = Array.from({ length: 200 }, (_, i) => [`Burst${i}:away`, `Burst${i}:chat`]).flat()
        let resolveCommitted!: () => void
        const committed = new Promise<void>(resolve => { resolveCommitted = resolve })
        const batchAddOccupants = w.__roomStore.getState().batchAddOccupants
        w.__roomStore.setState({ batchAddOccupants: (room, occupants) => {
          if (room === jid) applied.push(...occupants.map(occupant => `${occupant.nick}:${occupant.show}`))
          batchAddOccupants(room, occupants)
          if (applied.length === expected.length) resolveCommitted()
        } })
        const detach = w.__demoClient.subscribe('room:occupant-joined', ({ occupant }) => delivered.push(`${occupant.nick}:${occupant.show}`))
        const detachStore = w.__roomStore.subscribe((state, previous) => {
          if (state.rooms.get(jid)?.occupants !== previous.rooms.get(jid)?.occupants) notifications++
        })
        parser.on('error', (error: Error) => parserErrors.push(error.message))
        parser.on('element', stanza => { parsed++; w.__demoClient.rooms.handle(stanza) })
        parser.write('<stream:stream xmlns:stream="http://etherx.jabber.org/streams" xmlns="jabber:client">')
        const socket = new WebSocket(url)
        try {
          await new Promise<void>((resolve, reject) => {
            socket.onopen = () => socket.send(JSON.stringify({ spacing, singleFrame }))
            socket.onerror = () => reject(new Error('local presence fixture socket failed'))
            socket.onmessage = event => {
              if (event.data === 'END') { resolve(); return }
              try { parser.write(event.data) } catch (error) { parserErrors.push(String(error)) }
            }
          })
          // END means transport intake finished; the last store batch may still be queued.
          await committed
          // Let the store-driven React update paint before inspecting browser errors.
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
          return {
            parsed, delivered, applied, expected, notifications, parserErrors,
            final: Array.from({ length: 200 }, (_, i) => w.__roomStore.getState().getRoom(jid)?.occupants.get(`Burst${i}`)?.show),
          }
        } finally { socket.close(); detach(); detachStore(); w.__roomStore.setState({ batchAddOccupants }) }
      }, { jid: roomJid, spacing: spacingMs, singleFrame, url: presenceSocket })
      expect(result.parserErrors).toEqual([])
      expect(errors).toEqual([])
      expect(result.parsed).toBe(400)
      expect(result.delivered).toEqual(result.expected)
      expect(result.applied).toEqual(result.expected)
      expect(result.final).toEqual(Array(200).fill('chat'))
      if (singleFrame) expect(result.notifications).toBe(1)
      await expect(page.getByRole('button', { name: /(?:Show|Hide) members/ })).toBeVisible()
    })
  }
}
