import type { Message } from '@fluux/sdk'
import { hoursAgo, daysAgo, minutesAgo } from '@fluux/sdk/demo'
import { DOMAIN, SELF_JID } from '../constants'

const conv = `ava@${DOMAIN}`

export const AVA_MESSAGES: Message[] = [
  // Professional product discussion (yesterday)
  {
    type: 'chat', id: 'demo-ava-1', from: conv, body: 'I\'ve been reviewing the Q1 user feedback — a few themes keep coming up',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-2', from: SELF_JID, body: 'What are the top asks?',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-3', from: conv, body: 'Message search is #1 by far. Users want to find old conversations quickly. Reactions and threads are close behind.',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    reactions: { '📊': [SELF_JID] } as Record<string, string[]>,
  },
  {
    type: 'chat', id: 'demo-ava-4', from: SELF_JID, body: 'Good news — search shipped last week with full archive support. I\'ll demo it at the next all-hands',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-5', from: conv, body: 'That\'s great timing! I\'ll update the roadmap and send the changelog to beta testers',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  // Today — roadmap discussion
  {
    type: 'chat', id: 'demo-ava-6', from: conv, body: 'For Q2, I\'m thinking we prioritize: voice/video calls, end-to-end encryption, and mobile apps',
    timestamp: hoursAgo(6), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-7', from: SELF_JID, body: 'Voice/video is the biggest lift. We\'d need to integrate Jingle (XEP-0166) for that',
    timestamp: hoursAgo(5.5), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-8', from: conv, body: 'What about OMEMO for E2EE? The privacy-focused users have been very vocal about it',
    timestamp: hoursAgo(5), isOutgoing: false, conversationId: conv,
    replyTo: { id: 'demo-ava-7', fallbackBody: 'Voice/video is the biggest lift. We\'d need to integrate Jingle (XEP-0166) for that' },
    securityContext: { protocolId: 'openpgp', trust: 'verified' },
  },
  {
    type: 'chat', id: 'demo-ava-9', from: SELF_JID, body: 'OMEMO (XEP-0384) is on the list — it\'s well-specified and we have a good crypto library ready. Should be feasible in Q2.',
    timestamp: hoursAgo(4.5), isOutgoing: true, conversationId: conv,
    reactions: { '🔐': [conv], '🙌': [conv] } as Record<string, string[]>,
    securityContext: { protocolId: 'openpgp', trust: 'tofu' },
  },
  {
    type: 'chat', id: 'demo-ava-10', from: conv, body: 'Heads up — a new device is on my account. I haven\'t verified its fingerprint yet.',
    timestamp: hoursAgo(4), isOutgoing: false, conversationId: conv,
    securityContext: { protocolId: 'openpgp', trust: 'untrusted', notes: ['New device — verification pending'] },
  },
  // Tight burst demonstrating the group-break-on-trust-change behaviour.
  // Without the rule, ava-12 would group silently under ava-11; with it,
  // the yellow lock re-appears and signals that a different device sent it.
  {
    type: 'chat', id: 'demo-ava-11', from: conv, body: 'Following up on search — I\'ll put together a proper rollout plan this week.',
    timestamp: minutesAgo(4), isOutgoing: false, conversationId: conv,
    securityContext: { protocolId: 'openpgp', trust: 'tofu' },
  },
  {
    type: 'chat', id: 'demo-ava-12', from: conv, body: '…and just noting that this reply is from my laptop — haven\'t verified its key from phone yet.',
    timestamp: minutesAgo(3), isOutgoing: false, conversationId: conv,
    securityContext: { protocolId: 'openpgp', trust: 'untrusted' },
  },
  {
    type: 'chat', id: 'demo-ava-13', from: conv, body: 'Back on the main device now.',
    timestamp: minutesAgo(2), isOutgoing: false, conversationId: conv,
    securityContext: { protocolId: 'openpgp', trust: 'tofu' },
  },
  // Example of a signature that failed to verify — the lock stays yellow
  // but the tooltip now reads "Signature did not verify" so the user can
  // tell this apart from the benign "sender key not cached" case above.
  {
    type: 'chat', id: 'demo-ava-14', from: conv, body: 'Weird — this message shows up but my laptop says it couldn\'t verify the signature. Hmm.',
    timestamp: minutesAgo(1), isOutgoing: false, conversationId: conv,
    securityContext: {
      protocolId: 'openpgp',
      trust: 'untrusted',
      notes: ['Signature did not verify'],
    },
  },
  // Separator so the next message gets its own avatar + lock in the demo
  // (consecutive untrusted messages from the same sender are grouped
  // together by the UI).
  {
    type: 'chat', id: 'demo-ava-14b', from: SELF_JID, body: 'Let me take a look.',
    timestamp: minutesAgo(1), isOutgoing: true, conversationId: conv,
    securityContext: { protocolId: 'openpgp', trust: 'tofu' },
  },
  // Example of the decrypt-failure fallback path: the sender-supplied
  // fallback body surfaces with a yellow lock whose tooltip reads
  // "Could not decrypt". This is what the user sees when Sequoia can't
  // open the ciphertext (wrong subkey, corrupt payload, unsupported
  // cipher suite, etc.) — the message shows up rather than being
  // silently dropped.
  {
    type: 'chat', id: 'demo-ava-15', from: conv, body: '[OpenPGP-encrypted message]',
    timestamp: minutesAgo(1), isOutgoing: false, conversationId: conv,
    securityContext: {
      protocolId: 'openpgp',
      trust: 'untrusted',
      notes: ['Could not decrypt'],
    },
  },
  // Example of an *unsupported* encryption method: the peer sent an OMEMO
  // message but no OMEMO plugin is registered. The sender's plaintext fallback
  // <body> (chosen by their client, in their language) must NOT surface as if
  // it were a real message — a localized "Encrypted message — OMEMO not
  // supported" notice renders instead (UnsupportedEncryptionNotice).
  {
    type: 'chat', id: 'demo-ava-16', from: conv,
    body: "You received a message encrypted with OMEMO but your client doesn't support OMEMO or its support is currently disabled.",
    timestamp: minutesAgo(1), isOutgoing: false, conversationId: conv,
    unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
  },
]
