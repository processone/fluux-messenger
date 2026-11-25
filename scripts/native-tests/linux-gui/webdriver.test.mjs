import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebDriver } from './webdriver.mjs'

test('session forwards an owned WebView2 folder while preserving default native capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fluux-session-wire-'))
  const profile = join(root, 'webview')
  const requests = []
  const sessions = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    const sessionId = randomUUID()
    sessions.push(sessionId)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ value: { sessionId } }))
  })
  try {
    await mkdir(profile)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const client = new WebDriver(server.address().port, () => {})
    await client.session(process.execPath)
    assert.equal(client.id, sessions[0])
    await client.session(process.execPath, { userDataFolder: profile })
    assert.equal(client.id, sessions[1])
    assert.deepEqual(requests, [
      { method: 'POST', path: '/session', body: { capabilities: { alwaysMatch: { 'tauri:options': { application: process.execPath } } } } },
      { method: 'POST', path: '/session', body: { capabilities: { alwaysMatch: { 'tauri:options': { application: process.execPath, webviewOptions: { userDataFolder: profile } } } } } },
    ])
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true })
  }
})
