import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// The app extensions declared in src-tauri/mobile/ios/project.yml, by bundle identifier suffix.
const EXTENSIONS = ['share', 'notification', 'widgets']
const EXTENSION_TARGETS = ['FluuxShare', 'FluuxNotification', 'FluuxWidgets']

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

// XcodeGen emits XML plists. Replace whole identity values, not prefixes: a demo identifier
// extends the regular identifier, and unrelated URLs or capabilities must stay untouched.
function retargetMetadata(contents, from, to) {
  const values = new Map([
    [from, to],
    [`group.${from}.share`, `group.${to}.share`],
    ...['', '.notification', '.notification-preview'].map(suffix => [
      `$(AppIdentifierPrefix)${from}${suffix}`, `$(AppIdentifierPrefix)${to}${suffix}`,
    ]),
  ])
  return contents.replace(/<string>([^<]*)<\/string>/g, (element, value) =>
    values.has(value) ? `<string>${values.get(value)}</string>` : element)
}

/**
 * Runs `build` with the app extensions and all four targets' shared metadata under `identifier`.
 * Tauri retargets the app target only; its custom plist values and the extensions keep the
 * identity from initialization. Both the lookup group and entitlement must follow the variant.
 * Restores metadata byte-for-byte even if the build rewrites it or throws, while preserving
 * Tauri's app-target project updates and moving the extension identifiers back.
 */
export function withExtensionsUnder(pbxprojPath, projectIdentifier, identifier, build) {
  if (identifier === projectIdentifier) return build()
  const apple = dirname(dirname(pbxprojPath))
  const appTarget = `${basename(dirname(pbxprojPath), '.xcodeproj')}_iOS`
  // Read every required file before changing anything or allowing the build to start.
  const saved = [appTarget, ...EXTENSION_TARGETS].flatMap(target =>
    ['Info.plist', `${target}.entitlements`].map(name => {
      const path = join(apple, target, name)
      return [path, readFileSync(path)]
    }))
  const project = readFileSync(pbxprojPath, 'utf8')
  try {
    writeFileSync(pbxprojPath, retargetExtensions(project, projectIdentifier, identifier))
    for (const [path, contents] of saved) {
      writeFileSync(path, retargetMetadata(contents.toString('utf8'), projectIdentifier, identifier))
    }
    return build()
  } finally {
    for (const [path, contents] of saved) writeFileSync(path, contents)
    writeFileSync(pbxprojPath, retargetExtensions(readFileSync(pbxprojPath, 'utf8'), identifier, projectIdentifier))
  }
}
