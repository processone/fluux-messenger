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
 * The desktop AppBar (see components/AppBar.tsx) hosts the macOS traffic lights
 * on a full-width strip above the whole layout, so no header needs top-margin
 * clearance for them anymore.
 */
export function useWindowDrag() {
  return {
    // Drag region props to spread on elements (harmless in web, enables dragging in Tauri)
    dragRegionProps: {
      'data-tauri-drag-region': true,
    } as DragRegionProps,
  }
}
