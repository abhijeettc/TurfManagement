package `in`.turfsync.spike

import android.content.Context

class DeviceConfig(context: Context) {
    private val preferences = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var apiUrl: String
        get() = preferences.getString(API_URL, DEFAULT_API_URL) ?: DEFAULT_API_URL
        set(value) = preferences.edit().putString(API_URL, value.trim().trimEnd('/')).apply()

    var deviceToken: String
        get() = preferences.getString(DEVICE_TOKEN, "") ?: ""
        set(value) = preferences.edit().putString(DEVICE_TOKEN, value.trim()).apply()

    /**
     * Where TurfPro's own owner panel lives, for [TurfProLoginActivity] and
     * [TurfProRunner]. Separate from [apiUrl] on purpose: TurfPro is a third
     * party's hosted app, not part of the TurfSync server, and the two need
     * not share a host.
     */
    var turfProUrl: String
        get() = preferences.getString(TURFPRO_URL, DEFAULT_TURFPRO_URL) ?: DEFAULT_TURFPRO_URL
        set(value) = preferences.edit().putString(TURFPRO_URL, value.trim().trimEnd('/')).apply()

    fun isConfigured(): Boolean = apiUrl.isNotBlank() && deviceToken.isNotBlank()

    companion object {
        private const val FILE = "turfsync_device"
        private const val API_URL = "api_url"
        private const val DEVICE_TOKEN = "device_token"
        private const val TURFPRO_URL = "turfpro_url"
        private const val DEFAULT_API_URL = "https://corrected-supply-composer-knock.trycloudflare.com"
        private const val DEFAULT_TURFPRO_URL = "https://turfpro-v6bm.onrender.com"
    }
}
