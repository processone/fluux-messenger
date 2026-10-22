import { createLucideIcon } from 'lucide-react'

export const AccessibilityIcon = createLucideIcon({
  name: 'universal-access',
  size: 24,
  node: [
    ['circle', { cx: '12', cy: '12', r: '10', key: 'outline' }],
    ['circle', { cx: '12', cy: '7', r: '1', key: 'head' }],
    ['path', { d: 'm7 10 5 1 5-1', key: 'arms' }],
    ['path', { d: 'M12 11v3', key: 'body' }],
    ['path', { d: 'm9 18 3-4 3 4', key: 'legs' }],
  ],
})
