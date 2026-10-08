import { readFileSync, writeFileSync } from 'node:fs'

// The app extensions declared in src-tauri/mobile/ios/project.yml, by bundle identifier suffix.
const EXTENSIONS = ['share', 'notification']

/** Moves the app extensions' bundle identifiers in an Xcode project from under `from` to under `to`. */
export function retargetExtensions(pbxproj, from, to) {
  return EXTENSIONS.reduce(
    (project, extension) => project.replaceAll(
      `PRODUCT_BUNDLE_IDENTIFIER = ${from}.${extension};`,
      `PRODUCT_BUNDLE_IDENTIFIER = ${to}.${extension};`,
    ),
    pbxproj,
  )
}

/**
 * Runs `build` with the app extensions identified under `identifier`, then moves them back under
 * `projectIdentifier`. A build config that changes the identifier makes Tauri retarget the app
 * target only, and Xcode refuses an extension whose identifier does not extend its app's.
 */
export function withExtensionsUnder(pbxprojPath, projectIdentifier, identifier, build) {
  if (identifier === projectIdentifier) return build()
  writeFileSync(pbxprojPath, retargetExtensions(readFileSync(pbxprojPath, 'utf8'), projectIdentifier, identifier))
  try {
    return build()
  } finally {
    writeFileSync(pbxprojPath, retargetExtensions(readFileSync(pbxprojPath, 'utf8'), identifier, projectIdentifier))
  }
}
