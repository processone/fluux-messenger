/**
 * A bot that answers slowly.
 *
 * This is the shape of any assistant backed by a real service: the answer takes
 * long enough that silence would look like a crash. So it acknowledges the
 * question, shows that it is working, posts a placeholder, and then edits that
 * placeholder in place rather than leaving a trail of half-answers behind.
 *
 * Replace {@link answer} with a call to whatever actually produces the reply.
 *
 * ```bash
 * FLUUX_JID=bot@example.com FLUUX_PASSWORD=secret \
 *   npx tsx examples/assistant.ts [room@conference.example.com]
 * ```
 */

import { XMPPClient } from '@fluux/sdk/core'
import type { Message, RoomMessage } from '@fluux/sdk/core'
import { checkForMention, getBareJid, getLocalPart } from '@fluux/sdk/core'
import { pathToFileURL } from 'node:url'
import { loadConfig, routeSdkLogsToStderr } from './config'

/** A question the bot has decided to answer, and everything needed to reply. */
export interface Question {
  /** Who to address the answer to: the room, or the person. */
  to: string
  /** The message being answered, for the acknowledgement and the reply. */
  messageId: string
  /** Full sender address required by XEP-0461 reply metadata. */
  messageFrom: string
  text: string
}

/**
 * Stand-in for the real work. Anything that takes long enough to be worth
 * acknowledging belongs here: a model call, a database query, a slow API.
 */
async function answer(question: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 3000))
  return `You asked: "${question}". This is where a real answer would go.`
}

/**
 * Acknowledge, work visibly, then replace the placeholder with the answer.
 *
 * The correction is the point: the asker's client shows one message that turns
 * into the answer, instead of a placeholder followed by a second message that
 * pushes it out of view.
 */
export async function respond(client: XMPPClient, question: Question): Promise<void> {
  // Tell the asker it landed, before anything slow starts.
  await client.messages.sendReaction(question.to, question.messageId, ['👀'])
  await client.messages.sendChatState(question.to, 'composing')

  const placeholderId = await client.messages.sendMessage(question.to, 'Working on it…', {
    replyTo: { id: question.messageId, to: question.messageFrom },
  })

  try {
    const text = await answer(question.text)
    await client.messages.sendCorrection(question.to, placeholderId, text)
  } catch (error) {
    // The placeholder is already on everyone's screen, so a failure has to
    // replace it. Leaving it saying "Working on it…" forever is worse than
    // saying the work failed.
    const reason = error instanceof Error ? error.message : String(error)
    await client.messages.sendCorrection(question.to, placeholderId, `Sorry, that failed: ${reason}`)
  }
}

/** Start answering without blocking the subscription callback, reporting failures. */
export function respondInBackground(client: XMPPClient, question: Question): Promise<void> {
  return respond(client, question).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Could not answer ${question.messageId}: ${reason}`)
  })
}

/**
 * Decide whether a one-to-one message is a question for us.
 *
 * Everything sent directly to the bot is. The two exclusions are messages the
 * bot itself sent (carbons of its own replies would otherwise loop) and
 * archived ones replayed at startup, which are already answered.
 */
export function questionFromChat(message: Message): Question | null {
  if (message.isOutgoing || message.isDelayed) return null
  if (!message.body.trim()) return null

  return {
    to: getBareJid(message.from),
    messageId: message.id,
    messageFrom: message.from,
    text: message.body,
  }
}

/**
 * Decide whether a room message is a question for us.
 *
 * In a room the bot answers only when addressed, so it needs its own nickname
 * to recognise a mention. `isOutgoing` is not enough to skip our own messages
 * here: on join, the service replays history in which our past messages are
 * indistinguishable from anyone else's, which is what `isDelayed` covers.
 */
export function questionFromRoom(message: RoomMessage, nickname: string): Question | null {
  if (message.isOutgoing || message.isDelayed) return null
  if (message.nick === nickname) return null
  if (!checkForMention(message.body, nickname)) return null

  return {
    to: message.roomJid,
    messageId: message.id,
    messageFrom: message.from,
    text: message.body,
  }
}

async function main(): Promise<void> {
  const room = process.argv[2]
  routeSdkLogsToStderr()
  const config = await loadConfig()
  const nickname = getLocalPart(config.jid)

  const client = new XMPPClient()

  client.subscribe('chat:message', ({ message }) => {
    const question = questionFromChat(message)
    if (question) void respondInBackground(client, question)
  })

  client.subscribe('room:message', ({ message }) => {
    const question = questionFromRoom(message, nickname)
    if (question) void respondInBackground(client, question)
  })

  await client.connect(config)
  console.log(`Connected as ${config.jid}`)

  if (room) {
    await client.rooms.joinRoom(room, nickname)
    console.log(`Joined ${room} as ${nickname}; mention me to ask something.`)
  }

  const stop = async (): Promise<void> => {
    await client.disconnect()
    client.destroy()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
