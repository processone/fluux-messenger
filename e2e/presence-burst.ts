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
        const spacing = Number(message.toString())
        for (let i = 0; i < 200; i++) {
          for (const show of ['away', 'chat']) {
            socket.send(`<presence from="${roomJid}/Burst${i}"><show>${show}</show><x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="member" role="participant"/></x><occupant-id xmlns="urn:xmpp:occupant-id:0" id="burst-${i}"/></presence>`)
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
  for (const spacingMs of [0, 17]) {
    test(`400 presences at ${spacingMs}ms with members ${membersOpen ? 'open' : 'closed'}`, async ({ page, presenceSocket }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
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
      // WebKit reports the virtualizer's deferred resize notification on mount.
      // Keep the burst window strict: no errors are permitted during intake.
      const bootErrors = errors.splice(0)
      expect(bootErrors.filter(error => error !== 'ResizeObserver loop completed with undelivered notifications.')).toEqual([])

      const result = await page.evaluate(async ({ jid, spacing, url }) => {
        const w = window as unknown as PresenceLab
        const parser = new w.__presenceParser()
        const parserErrors: string[] = []
        let parsed = 0
        const delivered: string[] = []
        let notifications = 0
        const applied: string[] = []
        const batchAddOccupants = w.__roomStore.getState().batchAddOccupants
        w.__roomStore.setState({ batchAddOccupants: (room, occupants) => {
          if (room === jid) applied.push(...occupants.map(occupant => `${occupant.nick}:${occupant.show}`))
          batchAddOccupants(room, occupants)
        } })
        const detach = w.__demoClient.subscribe('room:occupant-joined', ({ occupant }) => delivered.push(`${occupant.nick}:${occupant.show}`))
        const detachStore = w.__roomStore.subscribe((state, previous) => {
          if (state.rooms.get(jid)?.occupants !== previous.rooms.get(jid)?.occupants) notifications++
        })
        parser.on('error', (error: Error) => parserErrors.push(error.message))
        parser.on('element', stanza => { parsed++; w.__demoClient.rooms.handle(stanza) })
        parser.write('<stream:stream xmlns:stream="http://etherx.jabber.org/streams" xmlns="jabber:client">')
        const expected = Array.from({ length: 200 }, (_, i) => [`Burst${i}:away`, `Burst${i}:chat`]).flat()
        const socket = new WebSocket(url)
        try {
          await new Promise<void>((resolve, reject) => {
            socket.onopen = () => socket.send(String(spacing))
            socket.onerror = () => reject(new Error('local presence fixture socket failed'))
            socket.onmessage = event => {
              if (event.data === 'END') { resolve(); return }
              try { parser.write(event.data) } catch (error) { parserErrors.push(String(error)) }
            }
          })
          await new Promise(resolve => setTimeout(resolve, 50))
          return {
            parsed, delivered, applied, expected, notifications, parserErrors,
            final: Array.from({ length: 200 }, (_, i) => w.__roomStore.getState().getRoom(jid)?.occupants.get(`Burst${i}`)?.show),
          }
        } finally { socket.close(); detach(); detachStore(); w.__roomStore.setState({ batchAddOccupants }) }
      }, { jid: roomJid, spacing: spacingMs, url: presenceSocket })
      expect(result.parserErrors).toEqual([])
      expect(errors).toEqual([])
      expect(result.parsed).toBe(400)
      expect(result.delivered).toEqual(result.expected)
      expect(result.applied).toEqual(result.expected)
      expect(result.final).toEqual(Array(200).fill('chat'))
      if (!spacingMs) expect(result.notifications).toBeLessThanOrEqual(2)
      await expect(page.getByRole('button', { name: /(?:Show|Hide) members/ })).toBeVisible()
    })
  }
}
