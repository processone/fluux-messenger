/**
 * The contract every anomaly sink satisfies.
 *
 * Lives in its own module so `memory.ts` does not have to import from `tauri.ts`
 * just to name the type it implements.
 *
 * @module Anomaly/Sinks/Contract
 */
export interface Sink {
  /**
   * Accept one serialized JSONL line, without its trailing newline.
   *
   * Fire-and-forget by design: the recorder is called from synchronous detector
   * paths and must never await I/O. A sink absorbs its own failures.
   */
  write(line: string): void

  /** Cumulative failed writes, surfaced in the digest as `recorder/sink-write-failed`. */
  failureCount(): number

  /** True once the sink has given up for this session. */
  disabled(): boolean
}
