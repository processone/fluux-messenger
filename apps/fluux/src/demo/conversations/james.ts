import type { Message } from '@fluux/sdk'
import { hoursAgo, daysAgo } from '@fluux/sdk'
import { DOMAIN, SELF_JID } from '../constants'

const conv = `james@${DOMAIN}`

export const JAMES_MESSAGES: Message[] = [
  // Earlier conversation about testing (2 days ago)
  {
    type: 'chat', id: 'demo-james-0a', from: conv, body: 'I set up the end-to-end test suite for the chat module',
    timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-0b', from: SELF_JID, body: 'What framework did you go with? Playwright or Cypress?',
    timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-0c', from: conv, body: 'Playwright — better for testing WebSocket connections and it runs headless in CI',
    timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-0d', from: SELF_JID, body: 'Good call. Can you add a test for the reconnection flow? That\'s been flaky',
    timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-0e', from: conv, body: 'On it. I\'ll simulate a network drop and verify the message queue is flushed after reconnect',
    timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
    reactions: { '🙌': [SELF_JID] } as Record<string, string[]>,
  },
  // Today's conversation
  {
    type: 'chat', id: 'demo-james-1', from: conv, body: 'Have you seen the blog post about the latest release?',
    timestamp: hoursAgo(6), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-2', from: conv,
    body: 'https://www.process-one.net/blog/fluux-messenger-0-13/',
    timestamp: hoursAgo(6), isOutgoing: false, conversationId: conv,
    linkPreview: {
      url: 'https://www.process-one.net/blog/fluux-messenger-0-13/',
      title: 'Fluux Messenger 0.13: group chat, reactions and more',
      description: 'Fluux Messenger 0.13 adds group chat support (MUC), emoji reactions, message replies, and improved file sharing — all built on XMPP standards.',
      siteName: 'ProcessOne',
      image: './demo/link-preview-fluux-013.png',
    },
  },
  {
    type: 'chat', id: 'demo-james-3', from: SELF_JID, body: 'Nice! The part about stream management is very relevant to what we\'re building next',
    timestamp: hoursAgo(5), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-4', from: conv, body: 'Exactly what I thought. We should leverage more of XEP-0198',
    timestamp: hoursAgo(5), isOutgoing: false, conversationId: conv,
    replyTo: { id: 'demo-james-3', fallbackBody: 'Nice! The part about stream management is very relevant to what we\'re building next' },
  },
  {
    type: 'chat', id: 'demo-james-5', from: SELF_JID, body: 'Already on it — session resumption is working nicely in the latest build 🚀',
    timestamp: hoursAgo(4), isOutgoing: true, conversationId: conv,
    reactions: { '💪': [conv] },
  },
  {
    type: 'chat', id: 'demo-james-6', from: conv,
    body: 'Here\'s how I wired up the reconnect handler:\n\n```typescript\nclient.on(\'disconnect\', async (reason) => {\n  if (reason === \'stream-error\') {\n    await client.resume({ prevId: session.id })\n  }\n})\n```\n\nPretty clean with the new SDK hooks!',
    timestamp: hoursAgo(3.5), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-7', from: SELF_JID,
    body: 'Nice! You can simplify it even further:\n\n```typescript\nconst { status } = useConnection({\n  autoResume: true,\n  onReconnect: () => console.log(\'Back online\'),\n})\n```',
    timestamp: hoursAgo(3), isOutgoing: true, conversationId: conv,
  },
  // Python code block — showcases multi-language syntax highlighting
  {
    type: 'chat', id: 'demo-james-7b', from: conv,
    body: 'Speaking of testing, here\'s the load test I wrote for the WebSocket layer:\n\n```python\nimport asyncio\nimport websockets\n\nasync def stress_test(url: str, n_clients: int = 100):\n    async def connect_and_send(client_id: int):\n        async with websockets.connect(url) as ws:\n            for i in range(50):\n                await ws.send(f"msg-{client_id}-{i}")\n                await asyncio.sleep(0.1)\n\n    tasks = [connect_and_send(i) for i in range(n_clients)]\n    await asyncio.gather(*tasks)\n    print(f"✅ {n_clients} clients completed")\n```\n\nHeld up well at 100 concurrent connections!',
    timestamp: hoursAgo(2.5), isOutgoing: false, conversationId: conv,
    reactions: { '🔥': [SELF_JID] } as Record<string, string[]>,
  },
  {
    type: 'chat', id: 'demo-james-7c', from: SELF_JID,
    body: 'The code block rendering looks great — syntax highlighting is working well',
    timestamp: hoursAgo(2.3), isOutgoing: true, conversationId: conv,
    attachment: {
      url: './demo/screenshot-code-block.png',
      name: 'code-block-rendering.png',
      mediaType: 'image/png',
      size: 134_847,
      width: 1280,
      height: 800,
    },
  },
  {
    type: 'chat', id: 'demo-james-7d', from: conv,
    body: 'From the XEP-0198 spec:\n\n> When a session is resumed, the server MUST replay any stanzas\n> that were not handled by the client before the disconnect.\n\nSo we should be safe with our current approach.',
    timestamp: hoursAgo(2.1), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-7e', from: SELF_JID,
    body: 'Right, and building on that:\n\n>> When a session is resumed, the server MUST replay any stanzas\n> This means our queue should be empty after resume\n\nExactly what I observed in testing.',
    timestamp: hoursAgo(2.05), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-8', from: conv, body: 'By the way, I found a bug in the error handling — when the server returns a 503, we retry immediately instead of backing off',
    timestamp: hoursAgo(2), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-james-9', from: SELF_JID, body: 'Good catch. Let\'s add exponential backoff with jitter to avoid thundering herd',
    timestamp: hoursAgo(1.8), isOutgoing: true, conversationId: conv,
  },
]
