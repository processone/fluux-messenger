package com.processone.fluux.keyboard

import android.app.Activity
import android.view.View
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

/**
 * Keeps the WebView above the soft keyboard.
 *
 * An edge-to-edge window is not resized for the keyboard: Android reports it as
 * a window inset and leaves the layout to the app. Padding the content view by
 * that inset shrinks the WebView, which the page sees as a viewport resize.
 */
@TauriPlugin
class KeyboardInsetsPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) = followKeyboard(activity)

    // Tauri loads a plugin once per process; a recreated activity has a new content view.
    override fun onResume(activity: AppCompatActivity) = followKeyboard(activity)

    private fun followKeyboard(activity: Activity) {
        val content = activity.findViewById<View>(android.R.id.content) ?: return
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            view.setPadding(0, 0, 0, keyboard)
            // The WebView must not apply again what the padding already took.
            insets.inset(0, 0, 0, keyboard)
        }
        ViewCompat.requestApplyInsets(content)
    }
}
