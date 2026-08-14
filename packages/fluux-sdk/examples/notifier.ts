/**
 * Send one message and exit.
 *
 * The smallest useful bot: a CI job or a cron script that reports somewhere.
 * It never reads a message, so it never needs the stores.
 *
 * ```bash
 * FLUUX_JID=bot@example.com FLUUX_PASSWORD=secret \
 *   npx tsx examples/notifier.ts user@example.com "build 412 is green"
 * ```
 */

import { XMPPClient } from '@fluux/sdk/core'
import { loadConfig, routeSdkLogsToStderr } from './config'

async function main(): Promise<void> {
  const [recipient, ...rest] = process.argv.slice(2)
  const body = rest.join(' ')
  if (!recipient || !body) {
    throw new Error('Usage: notifier.ts <recipient-jid> <message>')
  }

  routeSdkLogsToStderr()
  const config = await loadConfig()
  const client = new XMPPClient()

  await client.connect(config)
  await client.messages.sendMessage(recipient, body)

  // Disconnect rather than exiting: it closes the stream cleanly, so the server
  // does not have to time the session out and the message is acknowledged
  // before the process goes away.
  await client.disconnect()
  client.destroy()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
