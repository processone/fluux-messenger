/**
 * Props to spread on an element to make it a window drag region in Tauri.
 * Harmless in web (data attributes are ignored).
 */
export interface DragRegionProps {
  'data-tauri-drag-region': boolean
}

/**
 * Hook that returns props to make an element a window drag region.
 * Uses data-tauri-drag-region for Tauri native dragging.
 *
 * `titleBarClass` used to add a macOS top margin so column headers cleared the
 * overlaid traffic lights. The desktop AppBar (see components/AppBar.tsx) now
 * hosts the traffic lights on a full-width strip above the whole layout, so no
 * header needs that clearance anymore. The field is kept (as an empty string)
 * so existing consumers compile unchanged; the inert interpolation can be
 * dropped from each header in a follow-up cleanup.
 */
export function useWindowDrag() {
  return {
    titleBarClass: '',
    // Drag region props to spread on elements (harmless in web, enables dragging in Tauri)
    dragRegionProps: {
      'data-tauri-drag-region': true,
    } as DragRegionProps,
  }
}
