package org.unforced.uni

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge draws the WebView under the status and navigation bars, and the WebView did not keep
    // bottom-pinned controls (the update banner) clear of the Pixel's nav bar. Pad the content by the system
    // bars and display cutout, and hand the WebView those insets as consumed, so CSS env(safe-area-inset-*)
    // can't add the same space a second time (T-124, 0.1.48). The keyboard (IME) inset passes through untouched.
    val bars = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { v, insets ->
      val i = insets.getInsets(bars)
      v.setPadding(i.left, i.top, i.right, i.bottom)
      WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.NONE).build()
    }
  }
}
