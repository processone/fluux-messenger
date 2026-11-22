// Unit tests here own row subscriptions and request actions, not layout. Render
// all supplied rows without a viewport; long-pickers.ts owns real windowing,
// measured geometry, keyboard reveal and row-unmount behavior in both browsers.
export function useVirtualizer(options: { count: number; getItemKey: (index: number) => string | number }) {
  return {
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({
      key: options.getItemKey(index), index, start: 0,
    })),
    getTotalSize: () => 0,
    measureElement: () => {},
    scrollToIndex: () => {},
  }
}
