package `in`.turfsync.spike

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * TurfPro's owner panel inside TurfSync. The owner signs in here (password,
 * captcha, emailed OTP — all typed by them); [TurfProRunner] shares this
 * WebView's cookies, so once signed in, slot blocking runs by itself.
 * With [EXTRA_FINISH_ON_LOGIN] it closes as soon as the sign-in completes.
 */
class TurfProLoginActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "TurfPro sign-in"

        val host = Uri.parse(DeviceConfig(this).apiUrl).host
        if (host == null) {
            finish()
            return
        }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = WebViewClient()
        }
        setContentView(webView)
        webView.loadUrl("http://$host/admin/login")

        if (intent.getBooleanExtra(EXTRA_FINISH_ON_LOGIN, false)) {
            val check = object : Runnable {
                override fun run() {
                    val path = Uri.parse(webView.url ?: "").path.orEmpty()
                    if (path.startsWith("/admin") && !path.contains("/admin/login")) {
                        Toast.makeText(this@TurfProLoginActivity, "Signed in to TurfPro. Blocking will continue automatically.", Toast.LENGTH_LONG).show()
                        finish()
                    } else {
                        handler.postDelayed(this, 1000)
                    }
                }
            }
            handler.postDelayed(check, 2000)
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    companion object {
        const val EXTRA_FINISH_ON_LOGIN = "finish_on_login"
    }
}
