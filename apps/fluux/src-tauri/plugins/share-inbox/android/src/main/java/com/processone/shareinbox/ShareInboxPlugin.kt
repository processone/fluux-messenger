package com.processone.shareinbox

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.io.File

@TauriPlugin
class ShareInboxPlugin(private val host: Activity): Plugin(host) {
    @Command
    fun inboxPath(invoke: Invoke) {
        invoke.resolve(JSObject().put("path", File(host.filesDir, "ShareInbox").absolutePath))
    }
}
