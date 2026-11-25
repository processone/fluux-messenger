declare module 'virtual:search-corpus' {
  export function getDemoMessages(): Map<string, import('../../src/core/types').Message[]>
}
declare module 'virtual:search-index-v5' {
  export const search: import('../searchIndex.harness').WordIndex['search']
  export const closeSearchIndex: import('../searchIndex.harness').WordIndex['closeSearchIndex']
}
