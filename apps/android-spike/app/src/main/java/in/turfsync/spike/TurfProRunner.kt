package `in`.turfsync.spike

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Blocks one slot in TurfPro's existing owner panel the way a person would:
 * open the grounds list, tap the ground, pick the date, tap the slot, tap
 * "Block (n)" — all inside an in-app WebView, no change to TurfPro needed.
 *
 * The WebView shares the app's cookie store with [TurfProLoginActivity], so the
 * owner signs in to TurfPro once inside TurfSync (captcha + emailed OTP done by
 * them) and this reuses that session until TurfPro's cookie expires. It never
 * touches the captcha or OTP: on the login page it stops with [Result.LOGIN_NEEDED].
 *
 * Steps are driven by polling the page, so it follows TurfPro's client-side
 * navigation. Selectors match turfpro.mjs (the earlier Playwright adapter).
 */
class TurfProRunner(
    context: Context,
    private val task: JSONObject,
    private val onResult: (Result) -> Unit,
) {
    enum class Result { DONE, LOGIN_NEEDED, BOOKED, NO_SLOT, FAILED }

    private val appContext = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var startedAt = 0L
    private var finished = false
    private var lastStep: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    fun start() {
        handler.post {
            val host = Uri.parse(DeviceConfig(appContext).apiUrl).host
            if (host == null) {
                finish(Result.FAILED)
                return@post
            }
            val view = WebView(appContext)
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            view.webViewClient = WebViewClient()
            webView = view
            startedAt = System.currentTimeMillis()
            view.loadUrl("http://$host/admin/grounds")
            handler.postDelayed(poll, POLL_MS)
        }
    }

    private val poll = object : Runnable {
        override fun run() {
            val view = webView ?: return
            if (finished) return
            if (System.currentTimeMillis() - startedAt > TIMEOUT_MS) {
                // Record what the page was showing, so a stuck run can be diagnosed from the log.
                view.evaluateJavascript("(function(){return location.pathname+' | '+document.body.innerText.slice(0,300).replace(/\\s+/g,' ')})()") { page ->
                    Log.w(TAG, "task ${task.optString("id")} timed out on: $page")
                    finish(Result.FAILED)
                }
                return
            }
            view.evaluateJavascript(stepScript()) { raw ->
                if (finished) return@evaluateJavascript
                val step = raw?.trim('"')
                if (step != lastStep) {
                    lastStep = step
                    Log.d(TAG, "task ${task.optString("id")} step: $step (${view.url})")
                }
                when (step) {
                    "LOGIN" -> finish(Result.LOGIN_NEEDED)
                    "DONE" -> finish(Result.DONE)
                    "BOOKED" -> finish(Result.BOOKED)
                    "NOSLOT" -> finish(Result.NO_SLOT)
                    else -> handler.postDelayed(this, POLL_MS)
                }
            }
        }
    }

    private fun finish(result: Result) {
        if (finished) return
        finished = true
        handler.removeCallbacksAndMessages(null)
        webView?.destroy()
        webView = null
        Log.i(TAG, "task ${task.optString("id")} → $result")
        onResult(result)
    }

    /** One idempotent step of the flow, chosen from what the page currently shows. */
    private fun stepScript(): String {
        val ground = JSONObject.quote(task.optString("court"))
        val date = JSONObject.quote(task.optString("date"))
        val from = JSONObject.quote(task.optString("from"))
        val to = JSONObject.quote(task.optString("to"))
        return """
(function (ground, date, from, to) {
  var S = window.__ts = window.__ts || {};
  var p = location.pathname;
  if (/\/admin\/login/i.test(p)) return 'LOGIN';
  function t12(h) { var a = h.split(':'), H = +a[0], x = H % 12 === 0 ? 12 : H % 12; return (x < 10 ? '0' : '') + x + ':' + a[1] + ' ' + (H >= 12 ? 'PM' : 'AM'); }

  if (/^\/admin\/grounds\/?$/.test(p)) {
    var link = [].slice.call(document.querySelectorAll('a')).filter(function (l) { return l.textContent.trim() === ground; })[0];
    if (!link) return 'WAIT';
    if (!S.groundClicked || Date.now() - S.groundClicked > 6000) { S.groundClicked = Date.now(); link.click(); return 'STEP'; }
    return 'WAIT';
  }

  if (/^\/admin\/grounds\/[^\/]+\/?$/.test(p) && p.indexOf('/new') < 0) {
    if (document.body.innerText.indexOf('Slot Management') < 0) return 'WAIT';
    var d = document.querySelector('input[type="date"]');
    if (!d) return 'WAIT';
    if (!S.dateSet) {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(d, date);
      d.dispatchEvent(new Event('input', { bubbles: true }));
      d.dispatchEvent(new Event('change', { bubbles: true }));
      S.dateSet = Date.now();
      return 'STEP';
    }
    if (Date.now() - S.dateSet < 1500) return 'WAIT';

    var b = document.querySelector('button[title^="' + t12(from) + ' - ' + t12(to) + ' ("]');
    if (!b) return document.body.innerText.indexOf('No slots available') >= 0 ? 'NOSLOT' : 'WAIT';
    var st = (/\((\w+)/.exec(b.title) || [])[1];
    if (st === 'BLOCKED') return 'DONE';
    if (st === 'BOOKED' || st === 'PENDING') return 'BOOKED';
    if (st === 'AVAILABLE') {
      if (!S.slotClicked) { S.slotClicked = Date.now(); b.click(); return 'STEP'; }
      var blockBtn = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return /^Block \(\d+\)$/.test(x.textContent.trim()); })[0];
      if (blockBtn && !S.blockClicked) { S.blockClicked = Date.now(); blockBtn.click(); return 'STEP'; }
    }
    return 'WAIT';
  }
  return 'WAIT';
})($ground, $date, $from, $to)
"""
    }

    companion object {
        private const val TAG = "TurfProRunner"
        private const val POLL_MS = 700L
        private const val TIMEOUT_MS = 90_000L

        /** Fire-and-forget report to the TurfSync server that a task was blocked / needs a login. */
        fun report(context: Context, path: String, taskId: String, outcome: String? = null, detail: String? = null) {
            Thread {
                try {
                    val conn = URL("${DeviceConfig(context).apiUrl}/status/$path").openConnection() as HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    val body = JSONObject().put("id", taskId)
                    if (outcome != null) body.put("outcome", outcome)
                    if (detail != null) body.put("detail", detail)
                    conn.outputStream.use { it.write(body.toString().toByteArray()) }
                    conn.responseCode
                    conn.disconnect()
                } catch (e: Exception) {
                    Log.w(TAG, "report $path failed", e)
                }
            }.start()
        }
    }
}
