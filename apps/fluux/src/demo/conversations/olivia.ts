import type { Message } from '@fluux/sdk'
import { hoursAgo, daysAgo } from '@fluux/sdk/demo'
import { DOMAIN, SELF_JID } from '../constants'

const conv = `olivia@${DOMAIN}`

export const OLIVIA_MESSAGES: Message[] = [
  {
    type: 'chat', id: 'demo-olivia-1', from: conv, body: 'Hey! I\'ve been putting together the component library for the design system',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-olivia-2', from: SELF_JID, body: 'Awesome — are you using Figma tokens for the color palette?',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-olivia-3', from: conv, body: 'Yes! I exported the design tokens as JSON so we can import them directly into our theme config',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    reactions: { '🎯': [SELF_JID] } as Record<string, string[]>,
  },
  {
    type: 'chat', id: 'demo-olivia-4', from: SELF_JID, body: 'That\'s exactly what we need. How\'s the dark mode variant looking?',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-olivia-5', from: conv, body: 'Dark mode is working well — I adjusted the contrast ratios to meet WCAG AA for accessibility',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-olivia-5b', from: conv,
    body: 'Here\'s how the chat looks in dark mode',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    attachment: {
      url: './demo/screenshot-chat-dark.png',
      name: 'chat-dark-mode.png',
      mediaType: 'image/png',
      size: 157_430,
      width: 1280,
      height: 800,
    },
  },
  {
    type: 'chat', id: 'demo-olivia-5c', from: conv,
    body: 'And the light theme for comparison',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    attachment: {
      url: './demo/screenshot-chat-light.png',
      name: 'chat-light-mode.png',
      mediaType: 'image/png',
      size: 158_168,
      width: 1280,
      height: 800,
    },
  },
  {
    type: 'chat', id: 'demo-olivia-6', from: SELF_JID, body: 'Can you share the Figma link? I want to review the button variants',
    timestamp: hoursAgo(8), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-olivia-7', from: conv, body: 'Sure thing — I also added hover states and focus ring styles for keyboard navigation',
    timestamp: hoursAgo(7.5), isOutgoing: false, conversationId: conv,
  },
  // Edited message — showcases message correction (XEP-0308)
  {
    type: 'chat', id: 'demo-olivia-8', from: conv,
    body: 'The spacing system uses an 8px grid — keeps everything aligned and consistent across breakpoints. Updated to include the new 4px micro-spacing scale too.',
    timestamp: hoursAgo(7), isOutgoing: false, conversationId: conv,
    replyTo: { id: 'demo-olivia-6', fallbackBody: 'Can you share the Figma link? I want to review the button variants' },
    isEdited: true,
    originalBody: 'The spacing system uses an 8px grid — keeps everything aligned and consistent across breakpoints',
  },
  {
    type: 'chat', id: 'demo-olivia-9', from: SELF_JID, body: 'This is really solid work. Let\'s present it at the design review tomorrow',
    timestamp: hoursAgo(6.5), isOutgoing: true, conversationId: conv,
    reactions: { '🙌': [conv] } as Record<string, string[]>,
  },
]
