package `in`.turfsync.spike

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Pairs this phone with a venue. The token comes from the web app's Setup
 * page ("Pair new device" — POST /api/devices, shown once because only its
 * hash is stored server-side) and is typed in here once. After this,
 * MainActivity skips straight to the board and NotificationListener has what
 * it needs to post booking alerts.
 */
class DeviceSetupActivity : AppCompatActivity() {

    private lateinit var config: DeviceConfig
    private lateinit var apiUrlInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var accessStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_device_setup)
        config = DeviceConfig(this)

        apiUrlInput = findViewById(R.id.apiUrlInput)
        tokenInput = findViewById(R.id.tokenInput)
        accessStatus = findViewById(R.id.accessStatus)

        apiUrlInput.setText(config.apiUrl)
        tokenInput.setText(config.deviceToken)

        findViewById<Button>(R.id.grantAccessButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        findViewById<Button>(R.id.saveButton).setOnClickListener {
            val apiUrl = apiUrlInput.text.toString().trim()
            val token = tokenInput.text.toString().trim()
            if (apiUrl.isEmpty() || token.isEmpty()) {
                Toast.makeText(this, "Both fields are required.", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (!isNotificationAccessGranted()) {
                Toast.makeText(this, "Grant notification access first — otherwise nothing will ever be captured.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            config.apiUrl = apiUrl
            config.deviceToken = token

            // NotificationListenerService.onListenerConnected() — the only
            // moment it tries a heartbeat on its own — already fired the
            // instant notification access was granted, which happens before
            // this screen exists to save anything. Without this, the app
            // would sit "configured" for up to 5 minutes (the next scheduled
            // tick) before anyone could tell whether it actually worked.
            val button = findViewById<Button>(R.id.saveButton)
            button.isEnabled = false
            button.text = "Connecting…"
            confirmConnection(apiUrl, token) { ok, detail ->
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(
                        this,
                        if (ok) "Connected." else "Saved, but could not reach the server yet: $detail",
                        Toast.LENGTH_LONG,
                    ).show()
                    startActivity(Intent(this, MainActivity::class.java))
                    finish()
                }
            }
        }
    }

    /** A one-off heartbeat, purely to prove the address and token actually work right now. */
    private fun confirmConnection(apiUrl: String, token: String, onDone: (Boolean, String) -> Unit) {
        Thread {
            try {
                val body = JSONObject()
                    .put("label", "Counter tablet")
                    .put("notificationAccess", true)
                    .put("queuedOffline", 0)
                    .toString()
                val conn = URL("$apiUrl/devices/heartbeat").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("X-Device-Token", token)
                conn.doOutput = true
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.outputStream.use { it.write(body.toByteArray()) }
                val code = conn.responseCode
                conn.disconnect()
                if (code in 200..299) onDone(true, "") else onDone(false, "server said HTTP $code")
            } catch (e: Exception) {
                onDone(false, e.message ?: e.javaClass.simpleName)
            }
        }.start()
    }

    override fun onResume() {
        super.onResume()
        val granted = isNotificationAccessGranted()
        accessStatus.text = if (granted) "Notification access: granted" else "Notification access: not granted yet"
        accessStatus.setTextColor(if (granted) 0xFF2F7A52.toInt() else 0xFFB93327.toInt())
    }

    /**
     * There is no direct "is my listener bound" API — this reads the same
     * secure setting the OS itself uses to remember which listeners the user
     * has granted, and checks this app's service is in it.
     */
    private fun isNotificationAccessGranted(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return flat.split(":").any { it.contains(packageName) }
    }
}
