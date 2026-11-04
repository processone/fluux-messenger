import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The app extensions declared in src-tauri/mobile/ios/project.yml, by bundle identifier suffix.
const EXTENSIONS = ['share', 'notification', 'widgets']

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

// Generated beside the Xcode project: the widget reads its shared folder and the app's link scheme
// from these, so a build under another identifier must not keep the production ones.
const WIDGET_FILES = ['FluuxWidgets/Info.plist', 'FluuxWidgets/FluuxWidgets.entitlements']

/** Moves the widget's shared group and app link scheme from under `from` to under `to`. */
export function retargetWidgetFiles(contents, from, to) {
  return contents
    .replaceAll(`group.${from}.share`, `group.${to}.share`)
    .replaceAll(`<key>FluuxAppScheme</key>\n\t<string>${from}</string>`, `<key>FluuxAppScheme</key>\n\t<string>${to}</string>`)
}

function retargetWidgetFilesIn(directory, from, to) {
  for (const name of WIDGET_FILES) {
    const path = join(directory, name)
    if (existsSync(path)) writeFileSync(path, retargetWidgetFiles(readFileSync(path, 'utf8'), from, to))
  }
}

/**
 * Runs `build` with the app extensions identified under `identifier`, then moves them back under
 * `projectIdentifier`. A build config that changes the identifier makes Tauri retarget the app
 * target only, and Xcode refuses an extension whose identifier does not extend its app's.
 */
export function withExtensionsUnder(pbxprojPath, projectIdentifier, identifier, build) {
  if (identifier === projectIdentifier) return build()
  // The project sits in <apple>/<name>.xcodeproj; the generated widget files sit in <apple>.
  const apple = dirname(dirname(pbxprojPath))
  writeFileSync(pbxprojPath, retargetExtensions(readFileSync(pbxprojPath, 'utf8'), projectIdentifier, identifier))
  retargetWidgetFilesIn(apple, projectIdentifier, identifier)
  try {
    return build()
  } finally {
    retargetWidgetFilesIn(apple, identifier, projectIdentifier)
    writeFileSync(pbxprojPath, retargetExtensions(readFileSync(pbxprojPath, 'utf8'), identifier, projectIdentifier))
  }
}
