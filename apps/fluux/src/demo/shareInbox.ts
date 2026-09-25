import type { ShareInbox, SharedItem } from '@/utils/shareInbox'

const items: SharedItem[] = [
  { id: 'demo-link', text: 'https://fluux.io', name: null, mime: null, size: 0 },
  { id: 'demo-document', text: 'Project notes', name: 'notes.txt', mime: 'text/plain', size: 6 },
]
/** In-memory imports for demo.html?share=1; never reads device storage. */
export const demoShareInbox: ShareInbox = {
  list: async () => [...items],
  file: async item => item.name ? new File(['Notes\n'], item.name, { type: item.mime! }) : undefined,
  remove: async id => { const index = items.findIndex(item => item.id === id); if (index >= 0) items.splice(index, 1) },
}
