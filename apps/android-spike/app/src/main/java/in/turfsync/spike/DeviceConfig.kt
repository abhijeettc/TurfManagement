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

    fun isConfigured(): Boolean = apiUrl.isNotBlank() && deviceToken.isNotBlank()

    companion object {
        private const val FILE = "turfsync_device"
        private const val API_URL = "api_url"
        private const val DEVICE_TOKEN = "device_token"
        private const val DEFAULT_API_URL = "https://corrected-supply-composer-knock.trycloudflare.com"
    }
}
