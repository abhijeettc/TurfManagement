package `in`.turfsync.spike

import android.annotation.SuppressLint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Sign in — or sign up — on the tablet itself, and pair it in the same breath.
 *
 * The pairing code in [DeviceSetupActivity] assumes an account already exists
 * and that someone is sitting at a second screen to read a code off. Neither is
 * true for a venue owner who has just installed this: they have no account at
 * all, and nowhere for a code to come from. This is that missing first step.
 *
 * It loads the dashboard's own login page rather than reimplementing it: that
 * page already carries both sign-in and "Create an account" (with the venue
 * name and city a new venue needs), so there is one signup form in the product
 * rather than two that drift apart.
 *
 * Once a session cookie appears, the tablet mints its own device token through
 * the same POST /api/devices the dashboard's "Pair new device" button uses, and
 * stores that. The password is never seen by this code and never stored. The
 * session stays in the WebView's cookie jar on purpose — [MainActivity]'s
 * WebView shares it, so the owner lands on the board already signed in instead
 * of being asked a second time.
 */
class TurfSyncLoginActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private var pairing = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Sign in to TurfSync"

        val base = DeviceConfig(this).apiUrl
        if (base.isBlank()) {
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
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        webView.loadUrl("$base/login.html")

        // Polled rather than keyed off a URL: signup and sign-in land on
        // different pages, and both may redirect onwards to onboarding. The
        // session cookie is the one signal that means the same thing either way.
        val check = object : Runnable {
            override fun run() {
                if (!pairing && hasSession(base)) {
                    pairing = true
                    pairDevice(base)
                } else {
                    handler.postDelayed(this, 1000)
                }
            }
        }
        handler.postDelayed(check, 1500)
    }

    private fun hasSession(base: String): Boolean {
        val cookies = CookieManager.getInstance().getCookie(base) ?: return false
        return cookies.split(';').any { it.trim().startsWith("$SESSION_COOKIE=") }
    }

    /** Mint this tablet's own token off the freshly-created session. */
    private fun pairDevice(base: String) {
        val cookies = CookieManager.getInstance().getCookie(base) ?: return
        Toast.makeText(this, "Signed in. Pairing this device…", Toast.LENGTH_SHORT).show()

        Thread {
            var token: String? = null
            var detail: String? = null
            try {
                val conn = URL("$base/api/devices").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Cookie", cookies)
                conn.doOutput = true
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.outputStream.use { it.write(JSONObject().put("label", "Counter tablet").toString().toByteArray()) }

                val code = conn.responseCode
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()

                if (code in 200..299) {
                    token = JSONObject(text).optString("token").ifBlank { null }
                    if (token == null) detail = "the server did not return a token"
                } else {
                    // A venue owner always has device:pair; staff may not, and
                    // "nothing happened" would be a miserable way to find out.
                    detail = if (code == 403) "this account is not allowed to pair a device" else "server said HTTP $code"
                }
            } catch (e: Exception) {
                detail = e.message ?: e.javaClass.simpleName
            }

            val claimed = token
            handler.post {
                if (claimed == null) {
                    pairing = false
                    Toast.makeText(this, "Signed in, but pairing failed: ${detail ?: "unknown error"}", Toast.LENGTH_LONG).show()
                    return@post
                }
                DeviceConfig(this).deviceToken = claimed
                setResult(RESULT_OK)
                Toast.makeText(this, "This device is paired.", Toast.LENGTH_LONG).show()
                finish()
            }
        }.start()
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
        private const val SESSION_COOKIE = "turfsync_session"
    }
}
