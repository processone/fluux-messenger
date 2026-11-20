/** Prefix of the error the render-loop detector throws to break a loop. */
export const RENDER_LOOP_ERROR_PREFIX = 'Render loop detected'

export function isRenderLoopError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(RENDER_LOOP_ERROR_PREFIX)
}
