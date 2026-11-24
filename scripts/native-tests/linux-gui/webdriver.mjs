import { setTimeout as delay } from 'node:timers/promises'

export async function until(action, description, timeout = 30000) {
  const deadline = Date.now() + timeout
  let last
  do {
    try { return await action() } catch (error) { last = error }
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error(`${description}: ${last?.message ?? 'timed out'}`)
}

export class WebDriver {
  constructor(port, record) {
    this.base = `http://127.0.0.1:${port}`
    this.record = record
  }

  async command(method, path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    const data = await response.json()
    this.record({ method, path, status: response.status, response: data })
    if (!response.ok || data.value?.error) throw new Error(JSON.stringify(data))
    return data.value
  }

  async session(application) {
    const value = await this.command('POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application } } },
    })
    this.id = value.sessionId
    if (!this.id) throw new Error('Native driver returned no session ID')
    return value
  }

  async execute(script, args = []) {
    return this.command('POST', `/session/${this.id}/execute/sync`, { script, args })
  }

  async element(selector) {
    const value = await this.command('POST', `/session/${this.id}/element`, { using: 'css selector', value: selector })
    return value['element-6066-11e4-a52e-4f735466cecf']
  }

  async close() {
    if (this.id) await this.command('DELETE', `/session/${this.id}`)
  }
}
