/**
 * JSONL sidecar sink for the desktop build.
 *
 * Writes go through a single-flight promise chain so appends cannot interleave.
 * Every link absorbs its OWN failure: `q = q.then(write)` would propagate one
 * rejection to every subsequent link, silently ending logging for the rest of the
 * session while the file still looked like a healthy quiet day.
 *
 * Failures are also mirrored to `console.warn`, because the digest that would
 * report a broken sink cannot be written by that same broken sink. This is the one
 * place the structured log and the prose log deliberately overlap.
 *
 * @module Anomaly/Sinks/Tauri
 */
import { homeDir, localDataDir } from '@tauri-apps/api/path'
import { writeFile } from '@tauri-apps/plugin-fs'
import { platform } from '@tauri-apps/plugin-os'
import type { Sink } from './sink'

const MAX_CONSECUTIVE_FAILURES = 10

/**
 * @param writeLine - performs one durable append. Injected so the queue semantics
 * are testable without Tauri; production passes `createPluginFsWriter()`.
 */
export function createTauriSink(writeLine: (line: string) => Promise<void>): Sink {
  let chain: Promise<void> = Promise.resolve()
  let failures = 0
  let consecutive = 0
  let off = false

  return {
    write(line: string): void {
      if (off) return
      chain = chain.then(async () => {
        if (off) return
        try {
          await writeLine(line)
          consecutive = 0
        } catch (err) {
          failures++
          consecutive++
          console.warn(
            `[AnomalySink] write failed (${consecutive} consecutive): ${String(err)}`,
          )
          if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
            off = true
            console.warn(
              '[AnomalySink] disabled for this session after ' +
                `${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
            )
          }
        }
      })
    },
    failureCount: () => failures,
    disabled: () => off,
  }
}

/**
 * Resolve the sidecar directory, mirroring the Rust log-dir logic in
 * `src-tauri/src/main.rs` so the JSONL lands beside `fluux.log` — the directory
 * already reachable from the app menu and the tray.
 *
 * `localDataDir()` off macOS rather than a hand-built path: it is the exact JS
 * counterpart of `dirs::data_local_dir()`, which means LOCAL AppData on Windows
 * (not Roaming) and `$XDG_DATA_HOME` on Linux (not a hardcoded `~/.local/share`).
 *
 * Note the Rust side hardcodes `com.processone.fluux` regardless of bundle
 * identifier, so the Dev build writes here too. That is fine: the sidecar is
 * Dev-only, so it is unambiguous even though `fluux.log` itself interleaves builds.
 */
async function sidecarDir(): Promise<string> {
  if ((await platform()) === 'macos') {
    return `${await homeDir()}/Library/Logs/com.processone.fluux`
  }
  return `${await localDataDir()}/com.processone.fluux/logs`
}

/** `anomalies.YYYY-MM-DD.jsonl`, daily-rotated to match `fluux.log`. */
function fileNameFor(date: Date): string {
  return `anomalies.${date.toISOString().slice(0, 10)}.jsonl`
}

/**
 * Production writer: append one newline-terminated line.
 *
 * `writeFile`, NOT `writeTextFile` — they are different Tauri commands with
 * different permissions (`plugin:fs|write_file` vs `plugin:fs|write_text_file`),
 * and only the former is granted by the existing `fs:allow-write-file` entry. Using
 * `writeTextFile` would require widening `capabilities/default.json`, which applies
 * to the production app.
 *
 * @param now - injected so the daily rollover is testable.
 */
export function createPluginFsWriter(
  now: () => Date = () => new Date(),
): (line: string) => Promise<void> {
  return async (line: string): Promise<void> => {
    const path = `${await sidecarDir()}/${fileNameFor(now())}`
    await writeFile(path, new TextEncoder().encode(`${line}\n`), { append: true })
  }
}
