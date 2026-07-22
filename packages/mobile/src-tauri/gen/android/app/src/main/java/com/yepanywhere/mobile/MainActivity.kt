package com.yepanywhere.mobile

import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
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

    // Wait for WebView to be attached, then configure viewport and safe area
    window.decorView.viewTreeObserver.addOnGlobalLayoutListener(
      object : ViewTreeObserver.OnGlobalLayoutListener {
        override fun onGlobalLayout() {
          val webView = findWebView(window.decorView)
          if (webView != null) {
            Log.d("YepAnywhere", "WebView found, configuring viewport settings")
            webView.settings.useWideViewPort = true
            webView.settings.loadWithOverviewMode = true
            setupSafeArea(webView)
            // Reload if page already loaded so viewport settings take effect
            val currentUrl = webView.url
            if (currentUrl != null && currentUrl != "about:blank") {
              Log.d("YepAnywhere", "Reloading page to apply viewport settings")
              webView.reload()
            }
            window.decorView.viewTreeObserver.removeOnGlobalLayoutListener(this)
          }
        }
      }
    )
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
  private fun setupSafeArea(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val displayCutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())

      val top = maxOf(systemBars.top, displayCutout.top)
      val bottom = maxOf(systemBars.bottom, displayCutout.bottom)
      val left = maxOf(systemBars.left, displayCutout.left)
      val right = maxOf(systemBars.right, displayCutout.right)

      Log.d("YepAnywhere", "SafeArea insets - top:$top bottom:$bottom left:$left right:$right")

      webView.evaluateJavascript(
        """(function() {
          var root = document.documentElement;
          root.style.setProperty('--safe-area-top', '${top}px');
          root.style.setProperty('--safe-area-bottom', '${bottom}px');
          root.style.setProperty('--safe-area-left', '${left}px');
          root.style.setProperty('--safe-area-right', '${right}px');
          return JSON.stringify({iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio});
        })()""",
        { result ->
          Log.d("YepAnywhere", "Viewport info: $result")
        }
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
