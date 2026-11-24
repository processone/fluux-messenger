package com.processone.fluux.keyboard

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.lang.ref.WeakReference

/**
 * Keeps the WebView above the soft keyboard.
 *
 * An edge-to-edge window is not resized for the keyboard: Android reports it as
 * a window inset and leaves the layout to the app. Padding the content view by
 * that inset shrinks the WebView, which the page sees as a viewport resize.
 */
@TauriPlugin
class KeyboardInsetsPlugin(private val activity: Activity) : Plugin(activity) {
    private var contentView: WeakReference<View>? = null

    override fun load(webView: WebView) = followKeyboard(activity)

    @Command
    fun refresh(invoke: Invoke) {
        activity.runOnUiThread {
            contentView?.get()?.let { ViewCompat.requestApplyInsets(it) }
            invoke.resolve()
        }
    }

    // Tauri loads a plugin once per process; a recreated activity has a new content view.
    override fun onResume(activity: AppCompatActivity) = followKeyboard(activity)

    private fun followKeyboard(activity: Activity) {
        val content = activity.findViewById<View>(android.R.id.content) ?: return
        contentView = WeakReference(content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            // Both page viewports shrink after consumption, so only the native IME can confirm occlusion.
            val docked = insets.isVisible(WindowInsetsCompat.Type.ime()) && keyboard > 0
            findWebView(view)?.evaluateJavascript(
                "document.documentElement.dataset.keyboardDocked = '$docked';", null
            )
            view.setPadding(0, 0, 0, keyboard)
            // The WebView must not apply again what the padding already took.
            insets.inset(0, 0, 0, keyboard)
        }
        ViewCompat.requestApplyInsets(content)
    }

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findWebView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }
}
