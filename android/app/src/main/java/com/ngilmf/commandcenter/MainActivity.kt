package com.ngilmf.commandcenter

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * NG-ILMF Native Android WebView Host Activity (OPPO CPH1911 / Android 11+).
 *
 * Security invariants:
 * - Cleartext HTTP is only permitted to localhost / 127.0.0.1; remote hosts require HTTPS.
 * - `window.NgIlmfAndroidBridge` is strictly bound to trusted Command Center origins and is
 *   removed automatically if navigation attempts to leave the trusted origin.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var safBridge: SafStorageBridge
    private val bridgeExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    private var pendingPickerRequestId: String? = null
    private var trustedOriginAuthority: String = "127.0.0.1:3000"
    private var bridgeAttached: Boolean = false

    private val openDocumentTreeLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
            val requestId = pendingPickerRequestId ?: return@registerForActivityResult
            pendingPickerRequestId = null

            if (uri == null) {
                dispatchBridgeCallback(
                    requestId,
                    JSONObject().apply {
                        put("cancelled", true)
                        put("authorized", false)
                        put("state", "NOT_AUTHORIZED")
                        put("reason", "Owner cancelled SAF directory picker")
                    }
                )
                return@registerForActivityResult
            }

            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            try {
                contentResolver.takePersistableUriPermission(uri, flags)
                val verificationJson = safBridge.verifySafUriPermissionsJson(uri.toString())
                val payload = JSONObject(verificationJson).apply {
                    put("cancelled", false)
                    put("uri", uri.toString())
                    put("manufacturer", Build.MANUFACTURER)
                    put("model", Build.MODEL)
                    put("androidRelease", Build.VERSION.RELEASE)
                    put("sdkInt", Build.VERSION.SDK_INT)
                }
                dispatchBridgeCallback(requestId, payload)
            } catch (ex: SecurityException) {
                dispatchBridgeCallback(
                    requestId,
                    JSONObject().apply {
                        put("cancelled", false)
                        put("authorized", false)
                        put("revoked", true)
                        put("state", "NOT_AUTHORIZED")
                        put("uri", uri.toString())
                        put("reason", "takePersistableUriPermission failed: ${ex.message}")
                    }
                )
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        pendingPickerRequestId = savedInstanceState?.getString(KEY_PENDING_PICKER_REQUEST_ID)
        val initialUrl = sanitizeTargetUrl(intent.getStringExtra(EXTRA_COMMAND_CENTER_URL))
        trustedOriginAuthority = extractAuthority(Uri.parse(initialUrl))

        safBridge = SafStorageBridge(
            context = this,
            onLaunchTreePicker = { requestId, initialUri ->
                runOnUiThread {
                    pendingPickerRequestId = requestId
                    val parsedInitialUri = initialUri
                        ?.takeIf { it.startsWith("content://") }
                        ?.let { Uri.parse(it) }
                    openDocumentTreeLauncher.launch(parsedInitialUri)
                }
            },
            onRunIntegrityProbeAsync = { requestId, uriString ->
                bridgeExecutor.execute {
                    val resultJson = safBridge.runSafSha256ProbeJson(uriString)
                    val payload = try {
                        JSONObject(resultJson)
                    } catch (_: Exception) {
                        JSONObject().apply {
                            put("isNativeAndroidExecution", true)
                            put("uri", uriString)
                            put("state", "VERIFY_FAILED")
                            put("storageReady", false)
                            put("failureReason", "Malformed integrity probe payload")
                        }
                    }
                    dispatchBridgeCallback(requestId, payload)
                }
            }
        )

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url ?: return true
                    val allowed = isTrustedCommandCenterUri(url)
                    if (!allowed && bridgeAttached) {
                        view?.removeJavascriptInterface(BRIDGE_JS_NAME)
                        bridgeAttached = false
                    }
                    // Returning true blocks navigation outside trusted origin
                    return !allowed
                }

                override fun onPageStarted(
                    view: WebView?,
                    url: String?,
                    favicon: android.graphics.Bitmap?
                ) {
                    super.onPageStarted(view, url, favicon)
                    val parsed = url?.let { Uri.parse(it) }
                    if (parsed == null || !isTrustedCommandCenterUri(parsed)) {
                        if (bridgeAttached) {
                            view?.removeJavascriptInterface(BRIDGE_JS_NAME)
                            bridgeAttached = false
                        }
                        view?.stopLoading()
                    }
                }
            }
        }

        // Register the JS bridge strictly before loading the trusted URL
        webView.addJavascriptInterface(safBridge, BRIDGE_JS_NAME)
        bridgeAttached = true
        setContentView(webView)

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        )

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(initialUrl)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_PENDING_PICKER_REQUEST_ID, pendingPickerRequestId)
        if (::webView.isInitialized) {
            webView.saveState(outState)
        }
    }

    override fun onDestroy() {
        bridgeExecutor.shutdownNow()
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface(BRIDGE_JS_NAME)
            bridgeAttached = false
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun dispatchBridgeCallback(requestId: String, payload: JSONObject) {
        val safeJson = JSONObject.quote(payload.toString())
        val safeId = JSONObject.quote(requestId)
        webView.post {
            webView.evaluateJavascript(
                "window.__ngIlmfAndroidBridgeCallback && window.__ngIlmfAndroidBridgeCallback($safeId, JSON.parse($safeJson));",
                null
            )
        }
    }

    private fun extractAuthority(uri: Uri): String {
        val host = uri.host?.lowercase() ?: "127.0.0.1"
        val port = if (uri.port > 0) uri.port else if (uri.scheme?.lowercase() == "https") 443 else 80
        return "$host:$port"
    }

    private fun isTrustedCommandCenterUri(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        val host = uri.host?.lowercase() ?: return false
        val isLocal = host == "127.0.0.1" || host == "localhost"
        if (scheme == "http" && !isLocal) {
            return false
        }
        if (scheme != "http" && scheme != "https") {
            return false
        }
        val authority = extractAuthority(uri)
        return authority == trustedOriginAuthority || (isLocal && authority == "127.0.0.1:3000" || isLocal && authority == "localhost:3000")
    }

    private fun sanitizeTargetUrl(candidate: String?): String {
        val trimmed = candidate?.trim().orEmpty()
        if (trimmed.isEmpty()) return DEFAULT_LOCAL_URL
        val parsed = Uri.parse(trimmed)
        val scheme = parsed.scheme?.lowercase() ?: return DEFAULT_LOCAL_URL
        val host = parsed.host?.lowercase() ?: return DEFAULT_LOCAL_URL
        val isLocal = host == "127.0.0.1" || host == "localhost"
        return when {
            scheme == "https" -> trimmed
            scheme == "http" && isLocal -> trimmed
            else -> DEFAULT_LOCAL_URL
        }
    }

    companion object {
        const val BRIDGE_JS_NAME = "NgIlmfAndroidBridge"
        const val EXTRA_COMMAND_CENTER_URL = "COMMAND_CENTER_URL"
        private const val KEY_PENDING_PICKER_REQUEST_ID = "pending_picker_request_id"

        // Points to local Termux Node/Express server running on OPPO CPH1911
        const val DEFAULT_LOCAL_URL = "http://127.0.0.1:3000"

        @Suppress("unused")
        fun buildInitialTreeHintUri(volumeId: String = "857A-1AED", subPath: String = "V5"): Uri {
            return DocumentsContract.buildDocumentUri(
                "com.android.externalstorage.documents",
                "$volumeId:$subPath"
            )
        }
    }
}
