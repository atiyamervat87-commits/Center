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
 * Exposes `window.NgIlmfAndroidBridge` to the React Command Center frontend so all
 * Storage Access Framework (ACTION_OPEN_DOCUMENT_TREE), persistable URI grants,
 * permission checks, and SHA-256 read/write integrity probes execute genuinely on
 * the Android device rather than being simulated on a Linux host container.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var safBridge: SafStorageBridge
    private val bridgeExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    private var pendingPickerRequestId: String? = null

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
                    val url = request?.url ?: return false
                    val scheme = url.scheme?.lowercase()
                    // Keep http/https command center traffic inside the wrapper WebView
                    return scheme != "http" && scheme != "https"
                }
            }
        }

        // Register the JS bridge before loading the frontend URL
        webView.addJavascriptInterface(safBridge, BRIDGE_JS_NAME)
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
            val targetUrl = sanitizeTargetUrl(intent.getStringExtra(EXTRA_COMMAND_CENTER_URL))
            webView.loadUrl(targetUrl)
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

    private fun sanitizeTargetUrl(candidate: String?): String {
        val trimmed = candidate?.trim().orEmpty()
        if (trimmed.isEmpty()) return DEFAULT_LOCAL_URL
        val parsed = Uri.parse(trimmed)
        val scheme = parsed.scheme?.lowercase()
        return if (scheme == "http" || scheme == "https") trimmed else DEFAULT_LOCAL_URL
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
