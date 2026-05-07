package com.yepanywhere.mobile

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    onBackPressedDispatcher.addCallback(this) {
      val webView = findWebView(window.decorView)
      if (webView != null) {
        webView.evaluateJavascript("window.__TAURI_BACK_PRESSED__?.()", null)
      } else {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
      }
    }

    // Setup safe area insets for WebView (env() is unreliable on Android WebView)
    window.decorView.post {
      setupSafeArea()
    }
  }

  fun setSystemBars(light: Boolean) {
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.isAppearanceLightStatusBars = light
    controller.isAppearanceLightNavigationBars = light
  }

  /**
   * Inject safe area insets into WebView as CSS variables.
   * Android WebView's env(safe-area-inset-*) is unreliable,
   * so we use WindowInsets API and pass values via JavaScript.
   */
  private fun setupSafeArea() {
    val webView = findWebView(window.decorView) ?: return

    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val displayCutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())

      val top = maxOf(systemBars.top, displayCutout.top)
      val bottom = maxOf(systemBars.bottom, displayCutout.bottom)
      val left = maxOf(systemBars.left, displayCutout.left)
      val right = maxOf(systemBars.right, displayCutout.right)

      webView.evaluateJavascript(
        """(function() {
          var root = document.documentElement;
          root.style.setProperty('--safe-area-top', '${top}px');
          root.style.setProperty('--safe-area-bottom', '${bottom}px');
          root.style.setProperty('--safe-area-left', '${left}px');
          root.style.setProperty('--safe-area-right', '${right}px');
        })()""",
        null
      )

      insets
    }

    // Trigger initial insets application
    ViewCompat.requestApplyInsets(window.decorView)
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) {
        val child = view.getChildAt(i)
        val webView = findWebView(child)
        if (webView != null) return webView
      }
    }
    return null
  }
}
