package com.processone.shareinbox

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import java.io.File
import java.util.UUID
import org.json.JSONObject

/** Copies a granted URI while its temporary permission is still valid. */
class ReceiveShareActivity: Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Recreation must not import the same Intent twice.
        if (savedInstanceState != null) { finish(); return }
        val incoming = intent
        Thread {
            var staging: File? = null
            try {
                require(incoming.action == Intent.ACTION_SEND)
                val root = File(filesDir, "ShareInbox").apply { mkdirs() }
                val existing = root.listFiles() ?: emptyArray()
                existing.filter { it.name.startsWith(".") && System.currentTimeMillis() - it.lastModified() > 86400000L }
                    .forEach { it.deleteRecursively() }
                require(existing.count { !it.name.startsWith(".") } < 20)
                val text = incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: ""
                require(text.toByteArray(Charsets.UTF_8).size <= 65536)
                @Suppress("DEPRECATION")
                val uri = incoming.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                require(uri != null || text.isNotBlank())
                val id = UUID.randomUUID().toString()
                val dir = File(root, ".$id").apply { mkdir() }
                staging = dir
                var name: String? = null
                var mime: String? = null
                var size = 0L
                if (uri != null) {
                    require(uri.scheme == "content")
                    name = "attachment"
                    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                        if (it.moveToFirst() && !it.isNull(0)) name = it.getString(0).take(255)
                    }
                    mime = contentResolver.getType(uri) ?: "application/octet-stream"
                    contentResolver.openInputStream(uri)!!.use { input ->
                        File(dir, "data").outputStream().use { output ->
                            val buffer = ByteArray(65536)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                size += count
                                require(size <= 20L * 1024 * 1024)
                                output.write(buffer, 0, count)
                            }
                        }
                    }
                }
                val entry = JSONObject().put("id", id).put("text", text).put("size", size)
                    .put("name", name ?: JSONObject.NULL).put("mime", mime ?: JSONObject.NULL)
                File(dir, "entry.json").writeText(entry.toString())
                check(dir.renameTo(File(root, id)))
                runOnUiThread {
                    packageManager.getLaunchIntentForPackage(packageName)?.let {
                        it.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        startActivity(it)
                    }
                    finish()
                }
            } catch (_: Exception) {
                staging?.deleteRecursively()
                runOnUiThread {
                    val message = resources.getIdentifier("share_import_error", "string", packageName)
                    AlertDialog.Builder(this).setTitle("Fluux")
                        .setMessage(getString(message))
                        .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
                        .setOnCancelListener { finish() }.show()
                }
            }
        }.start()
    }
}
