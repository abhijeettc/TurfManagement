package `in`.turfsync.spike

import android.content.Intent
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Exposed to the dashboard as `window.TurfSyncNative`. The one method it
 * offers just launches another app — see PlatformApps — so a "Open Playo"
 * button on a sync task can skip the hunt for the icon. It does not, and
 * must never, do anything inside that app once opened.
 */
private class PlatformAppBridge(private val activity: MainActivity) {
    /**
     * "in" when TurfSync's in-app browser holds a live login for the platform, else "out".
     * Only TurfPro has one — the cookie TurfPro sets when the owner signs in (see TurfProLoginActivity).
     * It is the cookie's presence only; the cookie expires with the 7-day session.
     */
    @JavascriptInterface
    fun sessionStatus(platform: String): String {
        if (!platform.equals("turfpro", ignoreCase = true)) return "out"
        val base = DeviceConfig(activity).turfProUrl.ifBlank { return "out" }
        val cookies = android.webkit.CookieManager.getInstance().getCookie("$base/") ?: return "out"
        return if (cookies.split(';').any { it.trim().startsWith("turfbook_token=") }) "in" else "out"
    }

    @JavascriptInterface
    fun openPlatformApp(platform: String) {
        activity.runOnUiThread {
            val opened = PlatformApps.open(activity, platform)
            if (!opened) {
                Toast.makeText(activity, "No shortcut for $platform yet — open it from your home screen.", Toast.LENGTH_LONG).show()
            }
        }
    }
}

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val config = DeviceConfig(this)
        if (!config.isConfigured()) {
            startActivity(Intent(this, DeviceSetupActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)

        // After an app update Android can leave the notification listener unbound until it is
        // asked to reconnect; without it no WhatsApp booking is captured. Harmless if already bound.
        try {
            android.service.notification.NotificationListenerService.requestRebind(
                android.content.ComponentName(this, NotificationListener::class.java),
            )
        } catch (e: Exception) {
            android.util.Log.w("TurfSyncListener", "rebind request failed", e)
        }

        // Android 13+ needs this granted before the "Block needed" / "Sign in to TurfPro" notifications show.
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        webView = findViewById(R.id.webview)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.useWideViewPort = false
        webView.settings.loadWithOverviewMode = false
        webView.settings.setSupportZoom(false)
        // Safe here specifically because the WebView only ever loads our own
        // config.apiUrl — never arbitrary or third-party pages — so this
        // bridge can't be reached by untrusted content.
        webView.addJavascriptInterface(PlatformAppBridge(this), "TurfSyncNative")
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                view.loadData("<h2>Cannot connect to TurfSync</h2><p>Check the server address and Wi-Fi connection.</p>", "text/html", "UTF-8")
            }
        }
        webView.loadUrl(config.apiUrl)

        findViewById<Button>(R.id.deviceSetupButton).setOnClickListener {
            startActivity(Intent(this, DeviceSetupActivity::class.java))
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
