import assert from 'node:assert/strict'
import { accessSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createPlan, root } from './test-local.mjs'

// Accepted native macOS widget plan: the local gate must exercise the actual native reader/view
// owner, while edits shared with iOS retain iOS checks instead of claiming desktop proof covers it.
test('native widget implementation paths select the unsigned macOS behavior suite', () => {
  for (const path of [
    'apps/fluux/scripts/tauri-macos-widgets.mjs',
    'apps/fluux/src-tauri/plugins/widgets/macos/WidgetsBridge.swift',
    'apps/fluux/src-tauri/plugins/widgets/src/desktop.rs',
    'apps/fluux/src-tauri/mobile/ios/Widgets/UnreadWidgetView.swift',
    'apps/fluux/src-tauri/plugins/push/ios/Sources/NotificationAvatars/SharedNotificationStore.swift',
  ]) {
    accessSync(resolve(root, path))
    const plan = createPlan([{ path, status: 'M' }])
    assert.ok(plan.steps.some(step => step.args.includes('scripts/macos-widgets.test.mjs')), path)
    if (path.endsWith('SharedNotificationStore.swift')) {
      assert.ok(plan.steps.some(step => step.args.includes('test:ios-notifications')), 'keep the shared avatar model iOS owner')
    }
  }
})
