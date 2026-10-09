package org.unforced.uni

import android.util.Log
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executors

/**
 * Keeps Tauri's page-side bridge out of every frame except the app's own main frame.
 *
 * wry's Android webview registers its init scripts for all frames ("*") and exposes `window.ipc` to all
 * frames (addJavascriptInterface), so a sandboxed area frame saw `__TAURI_INTERNALS__` and could invoke
 * commands through `window.ipc.postMessage`. Three layers here:
 *  1. init scripts are registered only for the app's origins, which excludes the opaque origin of a
 *     sandboxed frame;
 *  2. each init script is guarded by `window.top === window`, so a same-origin sub-frame gets nothing either;
 *  3. `window.ipc` becomes a WebMessageListener limited to the same origins, and the native side drops
 *     anything that does not come from the main frame.
 * If the WebView lacks WebMessageListener the old interface stays and the sandbox self-test fails closed.
 */
object MainFrameOnly {
    /** Origins Tauri serves the app from on Android (`useHttpsScheme` false or true). `tauri android dev` is not covered. */
    val ORIGINS: Set<String> = setOf("http://tauri.localhost", "https://tauri.localhost")

    private const val TAG = "UniMainFrameOnly"
    private val ipcThread = Executors.newSingleThreadExecutor { r -> Thread(r, "uni-ipc") }

    fun guard(script: String): String = "if (window.top === window) {\n$script\n}"

    fun replaceIpc(webView: RustWebView, client: RustWebViewClient) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.w(TAG, "WebMessageListener unsupported: window.ipc stays reachable from every frame")
            return
        }
        webView.removeJavascriptInterface("ipc")
        WebViewCompat.addWebMessageListener(webView, "ipc", ORIGINS) { _, message: WebMessageCompat, _, isMainFrame, _ ->
            val data = message.data
            if (!isMainFrame) {
                Log.w(TAG, "dropped an ipc message from a sub-frame")
            } else if (data != null) {
                // JavascriptInterface calls ran on a background thread; keep the IPC off the UI thread, in order.
                ipcThread.execute { Rust.ipc(webView.id, client.currentUrl, data) }
            }
        }
    }
}
