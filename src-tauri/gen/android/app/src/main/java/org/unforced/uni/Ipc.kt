// Override of the wry 0.55.1 template (src/android/kotlin/Ipc.kt), T-79. The generated copy under generated/ is
// excluded from compilation in app/build.gradle.kts. Only the init block differs.
// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

@file:Suppress("unused")

package org.unforced.uni

import android.webkit.*

class Ipc(val webView: RustWebView, val webViewClient: RustWebViewClient) {
    init {
        // wry adds this object with addJavascriptInterface right after constructing it, which exposes
        // window.ipc to every frame, sealed area frames included. Replace it once that has run (T-79).
        webView.post { MainFrameOnly.replaceIpc(webView, webViewClient) }
    }

    @JavascriptInterface
    fun postMessage(message: String?) {
        message?.let {m ->
            // we're not using WebView::getUrl() here because it needs to be executed on the main thread
            // and it would slow down the Ipc
            // so instead we track the current URL on the webview client
            Rust.ipc(webView.id, webViewClient.currentUrl, m)
        }
    }

    
}
