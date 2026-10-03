package `in`.turfsync.spike

import android.content.Context
import android.webkit.CookieManager
import java.net.HttpURLConnection
import java.net.URL

/**
 * Is the owner signed in to an app inside TurfSync's in-app browser? Only TurfPro
 * has a session here today. It is judged from the app's own cookie store, then
 * confirmed with TurfPro's `/api/auth/me` using that cookie — so a session TurfPro
 * has already ended shows as signed out instead of lingering green.
 */
object SessionMonitor {
    enum class State { IN, OUT, UNKNOWN }

    /** (platform key, label) for every app whose sign-in lives in the in-app browser. */
    val PLATFORMS = listOf("turfpro" to "TurfPro")

    private const val COOKIE_NAME = "turfbook_token"

    private fun base(context: Context): String? = DeviceConfig(context).turfProUrl.ifBlank { null }

    private fun tokenCookie(context: Context): String? {
        val base = base(context) ?: return null
        val all = CookieManager.getInstance().getCookie("$base/") ?: return null
        return all.split(';').map { it.trim() }.firstOrNull { it.startsWith("$COOKIE_NAME=") }
    }

    /** Cheap, no network: is there a login cookie at all? (Used by the dashboard's status line.) */
    fun hasCookie(context: Context, platform: String): Boolean =
        platform.equals("turfpro", ignoreCase = true) && tokenCookie(context) != null

    /** Drops a login cookie TurfPro no longer accepts. */
    fun clear(context: Context) {
        val base = base(context) ?: return
        val manager = CookieManager.getInstance()
        manager.setCookie("$base/", "$COOKIE_NAME=; Max-Age=0; Path=/")
        manager.flush()
    }

    /** Blocking (network) — call off the main thread. */
    fun check(context: Context, platform: String): State {
        if (!platform.equals("turfpro", ignoreCase = true)) return State.OUT
        val cookie = tokenCookie(context) ?: return State.OUT
        val base = base(context) ?: return State.UNKNOWN
        return try {
            val conn = URL("$base/api/auth/me").openConnection() as HttpURLConnection
            conn.setRequestProperty("Cookie", cookie)
            conn.connectTimeout = 6000
            conn.readTimeout = 6000
            val code = try { conn.responseCode } finally { conn.disconnect() }
            when {
                code in 200..299 -> State.IN
                code == 401 || code == 403 -> { clear(context); State.OUT }
                else -> State.UNKNOWN
            }
        } catch (e: Exception) {
            State.UNKNOWN // server/Wi-Fi hiccup: say nothing rather than nag
        }
    }
}
