import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Tauri writes the capability manifests of the platform it builds for. The checked-in copy is the
// desktop one, which CI requires to stay up to date, so an iOS build must not leave its own behind.
const PLATFORM_DEPENDENT = ['src-tauri/gen/schemas/acl-manifests.json']

/** Runs `build`, then restores the platform-dependent generated files of `appDir` to their prior contents. */
export function withGeneratedFilesPreserved(appDir, build) {
  const saved = PLATFORM_DEPENDENT
    .map(path => join(appDir, path))
    .filter(path => existsSync(path))
    .map(path => [path, readFileSync(path)])
  try {
    return build()
  } finally {
    for (const [path, contents] of saved) writeFileSync(path, contents)
  }
}
