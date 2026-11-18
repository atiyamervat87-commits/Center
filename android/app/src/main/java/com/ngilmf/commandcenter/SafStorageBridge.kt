package com.ngilmf.commandcenter

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

class SafStorageBridge(
    private val context: Context,
    private val onLaunchTreePicker: (requestId: String, initialUri: String?) -> Unit,
    private val onRunIntegrityProbeAsync: ((requestId: String, uriString: String) -> Unit)? = null
) {
    @JavascriptInterface
    fun getDiagnosticsJson(): String {
        val resolver = context.contentResolver
        val persisted = resolver.persistedUriPermissions
        val urisArray = JSONArray()
        for (perm in persisted) {
            urisArray.put(
                JSONObject().apply {
                    put("uri", perm.uri.toString())
                    put("isReadPermission", perm.isReadPermission)
                    put("isWritePermission", perm.isWritePermission)
                    put("persistedTime", perm.persistedTime)
                }
            )
        }

        val termuxInstalled = try {
            context.packageManager.getPackageInfo("com.termux", 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }

        return JSONObject().apply {
            put("isNativeAndroid", true)
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("androidRelease", Build.VERSION.RELEASE)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("termuxPackageInstalled", termuxInstalled)
            put("persistedUriPermissions", urisArray)
        }.toString()
    }

    @JavascriptInterface
    fun openArchiveDocumentTree(requestId: String) {
        onLaunchTreePicker(requestId, null)
    }

    @JavascriptInterface
    fun openArchiveDocumentTreeWithHint(requestId: String, initialUri: String?) {
        onLaunchTreePicker(requestId, initialUri)
    }

    @JavascriptInterface
    fun runSafSha256ProbeAsync(requestId: String, uriString: String) {
        val asyncRunner = onRunIntegrityProbeAsync
        if (asyncRunner != null) {
            asyncRunner(requestId, uriString)
        } else {
            val result = runSafSha256ProbeJson(uriString)
            throw IllegalStateException("Async runner unavailable; sync result=$result")
        }
    }

    @JavascriptInterface
    fun verifySafUriPermissionsJson(uriString: String): String {
        if (uriString.isBlank() || !uriString.startsWith("content://")) {
            return JSONObject().apply {
                put("authorized", false)
                put("revoked", false)
                put("state", "NOT_AUTHORIZED")
                put("reason", "Only content:// SAF URIs are valid; raw filesystem paths are rejected.")
            }.toString()
        }

        val targetUri = Uri.parse(uriString)
        val resolver = context.contentResolver
        val persisted = resolver.persistedUriPermissions.firstOrNull { it.uri == targetUri }

        if (persisted == null || !persisted.isReadPermission || !persisted.isWritePermission) {
            return JSONObject().apply {
                put("authorized", false)
                put("revoked", true)
                put("state", "NOT_AUTHORIZED")
                put("reason", "Persisted SAF read/write permission missing or revoked by owner/system.")
            }.toString()
        }

        val tree = DocumentFile.fromTreeUri(context, targetUri)
        if (tree == null || !tree.exists() || !tree.isDirectory) {
            return JSONObject().apply {
                put("authorized", false)
                put("revoked", true)
                put("state", "NOT_MOUNTED")
                put("reason", "Selected SAF tree URI is unreachable or storage medium was unmounted.")
            }.toString()
        }

        val canRead = tree.canRead()
        val canWrite = tree.canWrite()

        val state = when {
            canRead && canWrite -> "AVAILABLE"
            canRead && !canWrite -> "READ_ONLY"
            else -> "NOT_AUTHORIZED"
        }

        return JSONObject().apply {
            put("authorized", canRead && canWrite)
            put("revoked", !(canRead && canWrite))
            put("readable", canRead)
            put("writable", canWrite)
            put("displayName", tree.name ?: "")
            put("state", state)
            put("uri", uriString)
            if (state != "AVAILABLE") {
                put("reason", "DocumentFile access check failed (state=$state)")
            }
        }.toString()
    }

    @JavascriptInterface
    fun runSafSha256ProbeJson(uriString: String): String {
        val permCheck = JSONObject(verifySafUriPermissionsJson(uriString))
        if (!permCheck.optBoolean("authorized", false)) {
            return JSONObject().apply {
                put("isNativeAndroidExecution", true)
                put("uri", uriString)
                put("state", permCheck.optString("state", "NOT_AUTHORIZED"))
                put("storageReady", false)
                put("contentMatched", false)
                put("cleanupCompleted", false)
                put("failureReason", permCheck.optString("reason", "SAF URI not authorized"))
            }.toString()
        }

        val targetUri = Uri.parse(uriString)
        val tree = DocumentFile.fromTreeUri(context, targetUri)
            ?: return JSONObject().apply {
                put("isNativeAndroidExecution", true)
                put("uri", uriString)
                put("state", "NOT_MOUNTED")
                put("storageReady", false)
                put("failureReason", "DocumentFile.fromTreeUri returned null")
            }.toString()

        val probeName = ".ng_ilmf_saf_probe_${UUID.randomUUID().toString().take(8)}.tmp"
        val payload = "NG-ILMF-ANDROID-SAF-PROBE|model=${Build.MODEL}|sdk=${Build.VERSION.SDK_INT}|ts=${System.currentTimeMillis()}"
        val expectedBytes = payload.toByteArray(Charsets.UTF_8)
        val expectedSha256 = sha256Hex(expectedBytes)

        val tempDoc = tree.createFile("application/octet-stream", probeName)
            ?: return JSONObject().apply {
                put("isNativeAndroidExecution", true)
                put("uri", uriString)
                put("state", "WRITE_TEST_FAILED")
                put("storageReady", false)
                put("expectedSha256", expectedSha256)
                put("failureReason", "DocumentFile.createFile failed inside SAF tree")
            }.toString()

        return try {
            context.contentResolver.openOutputStream(tempDoc.uri, "wt")?.use { out ->
                out.write(expectedBytes)
                out.flush()
            } ?: throw IllegalStateException("openOutputStream returned null")

            val actualBytes = context.contentResolver.openInputStream(tempDoc.uri)?.use { input ->
                input.readBytes()
            } ?: throw IllegalStateException("openInputStream returned null")

            val actualSha256 = sha256Hex(actualBytes)
            val matched = expectedBytes.contentEquals(actualBytes) && expectedSha256 == actualSha256

            if (!matched) {
                JSONObject().apply {
                    put("isNativeAndroidExecution", true)
                    put("uri", uriString)
                    put("testFileName", probeName)
                    put("state", "VERIFY_FAILED")
                    put("storageReady", false)
                    put("expectedSha256", expectedSha256)
                    put("actualSha256", actualSha256)
                    put("contentMatched", false)
                    put("cleanupCompleted", false)
                    put("failureReason", "SHA-256 mismatch after reading back SAF temporary file")
                }.toString()
            } else {
                // Delete ONLY the temporary probe file after verification succeeds
                val deleted = tempDoc.delete()
                JSONObject().apply {
                    put("isNativeAndroidExecution", true)
                    put("uri", uriString)
                    put("testFileName", probeName)
                    put("state", if (deleted) "AVAILABLE" else "VERIFY_FAILED")
                    put("storageReady", deleted)
                    put("expectedSha256", expectedSha256)
                    put("actualSha256", actualSha256)
                    put("contentMatched", true)
                    put("cleanupCompleted", deleted)
                    if (!deleted) {
                        put("failureReason", "Verification passed but temp SAF probe deletion returned false")
                    }
                }.toString()
            }
        } catch (ex: Exception) {
            JSONObject().apply {
                put("isNativeAndroidExecution", true)
                put("uri", uriString)
                put("testFileName", probeName)
                put("state", "WRITE_TEST_FAILED")
                put("storageReady", false)
                put("expectedSha256", expectedSha256)
                put("contentMatched", false)
                put("cleanupCompleted", false)
                put("failureReason", ex.message ?: "SAF I/O exception")
            }.toString()
        }
    }

    @JavascriptInterface
    fun revokeSafUriPermissionJson(uriString: String): String {
        return try {
            val uri = Uri.parse(uriString)
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            context.contentResolver.releasePersistableUriPermission(uri, flags)
            JSONObject().apply {
                put("revoked", true)
                put("uri", uriString)
            }.toString()
        } catch (ex: Exception) {
            JSONObject().apply {
                put("revoked", false)
                put("uri", uriString)
                put("error", ex.message ?: "Failed to release persistable permission")
            }.toString()
        }
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }
}
