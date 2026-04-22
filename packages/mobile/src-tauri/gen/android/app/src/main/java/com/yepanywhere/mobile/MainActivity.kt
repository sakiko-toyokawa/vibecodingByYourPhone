package com.yepanywhere.mobile

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
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
  }

  fun setSystemBars(light: Boolean) {
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.isAppearanceLightStatusBars = light
    controller.isAppearanceLightNavigationBars = light
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
