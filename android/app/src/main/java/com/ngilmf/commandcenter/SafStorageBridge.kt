package com.ngilmf.commandcenter

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.webkit.JavascriptInterface
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

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
    fun signAttestationChallengeJson(
        challenge: String,
        safUri: String,
        probeSha256: String?
    ): String {
        val message = "${Build.MODEL}|${Build.VERSION.SDK_INT}|${safUri.trim()}|${probeSha256?.trim().orEmpty()}|${challenge.trim()}"
        val mac = Mac.getInstance("HmacSHA256")
        val keySpec = SecretKeySpec(challenge.trim().toByteArray(Charsets.UTF_8), "HmacSHA256")
        mac.init(keySpec)
        val signatureHex = mac.doFinal(message.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return JSONObject().apply {
            put("proofSignature", signatureHex)
            put("model", Build.MODEL)
            put("sdkInt", Build.VERSION.SDK_INT)
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
            val cleaned = try {
                tempDoc.delete()
            } catch (_: Exception) {
                false
            }
            JSONObject().apply {
                put("isNativeAndroidExecution", true)
                put("uri", uriString)
                put("testFileName", probeName)
                put("state", "WRITE_TEST_FAILED")
                put("storageReady", false)
                put("expectedSha256", expectedSha256)
                put("contentMatched", false)
                put("cleanupCompleted", cleaned)
                put("failureReason", ex.message ?: "SAF I/O exception")
            }.toString()
        }
    }

    @JavascriptInterface
    fun writeSafArchiveFileJson(
        treeUriString: String,
        categoryFolder: String,
        fileName: String,
        base64Content: String
    ): String {
        val permCheck = JSONObject(verifySafUriPermissionsJson(treeUriString))
        if (!permCheck.optBoolean("authorized", false)) {
            return JSONObject().apply {
                put("ok", false)
                put("error", permCheck.optString("reason", "SAF URI not authorized"))
            }.toString()
        }
        return try {
            val rootTree = DocumentFile.fromTreeUri(context, Uri.parse(treeUriString))
                ?: throw IllegalStateException("SAF tree root unavailable")
            val safeRoot = rootTree.findFile("NG-ILMF_ARCHIVE")
                ?: rootTree.createDirectory("NG-ILMF_ARCHIVE")
                ?: throw IllegalStateException("Cannot initialize NG-ILMF_ARCHIVE via SAF")
            val safeCategory = categoryFolder.replace(Regex("[^A-Z0-9_]"), "_").ifBlank { "INVENTORY" }
            val catDir = safeRoot.findFile(safeCategory)
                ?: safeRoot.createDirectory(safeCategory)
                ?: throw IllegalStateException("Cannot create SAF category directory $safeCategory")

            val cleanName = fileName.replace(Regex("[^a-zA-Z0-9._-]"), "_")
            catDir.findFile(cleanName)?.delete()
            val targetDoc = catDir.createFile("application/octet-stream", cleanName)
                ?: throw IllegalStateException("DocumentFile.createFile failed for $cleanName")

            val bytes = Base64.decode(base64Content, Base64.DEFAULT)
            context.contentResolver.openOutputStream(targetDoc.uri, "wt")?.use { out ->
                out.write(bytes)
                out.flush()
            } ?: throw IllegalStateException("Failed to open SAF output stream")

            val readBack = context.contentResolver.openInputStream(targetDoc.uri)?.use { it.readBytes() }
                ?: throw IllegalStateException("Failed to read back SAF archive entry")
            val sha = sha256Hex(readBack)
            val expectedSha = sha256Hex(bytes)

            JSONObject().apply {
                put("ok", sha == expectedSha)
                put("documentUri", targetDoc.uri.toString())
                put("sha256", sha)
                put("sizeBytes", readBack.size)
            }.toString()
        } catch (ex: Exception) {
            JSONObject().apply {
                put("ok", false)
                put("error", ex.message ?: "SAF write failed")
            }.toString()
        }
    }

    @JavascriptInterface
    fun readVerifySafArchiveFileJson(
        documentUriString: String,
        expectedSha256: String
    ): String {
        return try {
            val docUri = Uri.parse(documentUriString)
            val bytes = context.contentResolver.openInputStream(docUri)?.use { it.readBytes() }
                ?: throw IllegalStateException("Document unreadable or missing")
            val actualSha = sha256Hex(bytes)
            JSONObject().apply {
                put("exists", true)
                put("sha256", actualSha)
                put("matched", actualSha == expectedSha256.lowercase())
                put("sizeBytes", bytes.size)
            }.toString()
        } catch (ex: Exception) {
            JSONObject().apply {
                put("exists", false)
                put("matched", false)
                put("error", ex.message ?: "SAF verify failed")
            }.toString()
        }
    }

    @JavascriptInterface
    fun deleteSafDocumentJson(documentUriString: String): String {
        return try {
            val doc = DocumentFile.fromSingleUri(context, Uri.parse(documentUriString))
            val deleted = doc?.delete() == true
            JSONObject().apply {
                put("deleted", deleted)
                put("uri", documentUriString)
            }.toString()
        } catch (ex: Exception) {
            JSONObject().apply {
                put("deleted", false)
                put("error", ex.message ?: "SAF delete failed")
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
