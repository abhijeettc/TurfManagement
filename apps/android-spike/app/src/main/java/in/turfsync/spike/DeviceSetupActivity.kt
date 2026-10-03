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
    private lateinit var codeInput: EditText
    private lateinit var accessStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_device_setup)
        config = DeviceConfig(this)

        apiUrlInput = findViewById(R.id.apiUrlInput)
        codeInput = findViewById(R.id.codeInput)
        accessStatus = findViewById(R.id.accessStatus)

        apiUrlInput.setText(config.apiUrl)

        findViewById<Button>(R.id.signInButton).setOnClickListener {
            if (!isNotificationAccessGranted()) {
                Toast.makeText(this, "Finish step 1 first — without notification access no booking is ever captured.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            // The address has to be saved before the sign-in screen opens: that
            // activity reads it back to know which server to load.
            config.apiUrl = apiUrlInput.text.toString().trim().ifBlank { config.apiUrl }
            startActivity(Intent(this, TurfSyncLoginActivity::class.java))
        }

        val codeToggle = findViewById<TextView>(R.id.codeToggle)
        codeToggle.setOnClickListener {
            val save = findViewById<Button>(R.id.saveButton)
            val shown = codeInput.visibility == android.view.View.VISIBLE
            val next = if (shown) android.view.View.GONE else android.view.View.VISIBLE
            codeInput.visibility = next
            save.visibility = next
            codeToggle.text = if (shown) "▸ I was given a pairing code" else "▾ I was given a pairing code"
        }

        val advanced = findViewById<TextView>(R.id.advancedToggle)
        advanced.setOnClickListener {
            val label = findViewById<TextView>(R.id.apiUrlLabel)
            val shown = apiUrlInput.visibility == android.view.View.VISIBLE
            val next = if (shown) android.view.View.GONE else android.view.View.VISIBLE
            label.visibility = next
            apiUrlInput.visibility = next
            advanced.text = if (shown) "▸ Advanced settings" else "▾ Advanced settings"
        }

        findViewById<Button>(R.id.grantAccessButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        // MIUI's own AutoStartManager rejects binding this service — silently, with the
        // notification-access toggle above still showing "granted" — unless the app is also
        // allowed in Settings > Apps > Permissions > Autostart. Confirmed on-device: the listener
        // can sit unbound for hours, rejected on every retry, until that toggle is turned on.
        // Not worth a dependency to detect this precisely, so: any Xiaomi-family build fingerprint.
        val isMiui = listOf("xiaomi", "redmi", "poco").any {
            android.os.Build.MANUFACTURER.contains(it, ignoreCase = true)
        }
        if (isMiui) {
            findViewById<TextView>(R.id.miuiFixLabel).visibility = android.view.View.VISIBLE
            findViewById<Button>(R.id.miuiFixButton).visibility = android.view.View.VISIBLE
            findViewById<Button>(R.id.miuiFixButton).setOnClickListener {
                val opened = try {
                    startActivity(
                        Intent().setClassName(
                            "com.miui.securitycenter",
                            "com.miui.permcenter.autostart.AutoStartManagementActivity",
                        ),
                    )
                    true
                } catch (e: Exception) {
                    false
                }
                if (!opened) {
                    Toast.makeText(
                        this,
                        "Could not open MIUI's Autostart screen — open Settings > Apps > Permissions > Autostart and allow TurfSync Owner by hand.",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }

        findViewById<Button>(R.id.saveButton).setOnClickListener {
            val apiUrl = apiUrlInput.text.toString().trim()
            // The field allows spaces so the code can be typed the way it is
            // displayed ("1234 5678"); the server wants the digits alone.
            val code = codeInput.text.toString().filter { it.isDigit() }
            if (apiUrl.isEmpty() || code.isEmpty()) {
                Toast.makeText(this, "Enter the pairing code from the dashboard.", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            if (!isNotificationAccessGranted()) {
                Toast.makeText(this, "Finish step 1 first — without notification access no booking is ever captured.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }

            val button = findViewById<Button>(R.id.saveButton)
            button.isEnabled = false
            button.text = "Pairing…"
            claimToken(apiUrl, code) { token, venueName, error ->
                Handler(Looper.getMainLooper()).post {
                    if (token == null) {
                        button.isEnabled = true
                        button.text = "Pair this device"
                        Toast.makeText(this, error ?: "Could not pair this device.", Toast.LENGTH_LONG).show()
                        return@post
                    }
                    config.apiUrl = apiUrl
                    config.deviceToken = token
                    Toast.makeText(this, "Paired with ${venueName ?: "your venue"}.", Toast.LENGTH_LONG).show()
                    startActivity(Intent(this, MainActivity::class.java))
                    finish()
                }
            }
        }
    }

    /**
     * Trade the typed code for this device's own token (POST /devices/claim).
     * Unauthenticated by design — the code is the only credential the tablet
     * has at this point, and it is spent the moment this succeeds.
     */
    private fun claimToken(apiUrl: String, code: String, onDone: (String?, String?, String?) -> Unit) {
        Thread {
            try {
                val body = JSONObject().put("code", code).toString()
                val conn = URL("$apiUrl/devices/claim").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.outputStream.use { it.write(body.toByteArray()) }

                val code2 = conn.responseCode
                val text = (if (code2 in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()

                val json = if (text.isNotBlank()) JSONObject(text) else JSONObject()
                if (code2 in 200..299) {
                    onDone(json.optString("token").ifBlank { null }, json.optString("venueName").ifBlank { null }, null)
                } else {
                    // The server's own wording is the useful part here — it is
                    // what distinguishes "expired" from "already used".
                    onDone(null, null, json.optString("error").ifBlank { "Pairing failed (HTTP $code2)" })
                }
            } catch (e: Exception) {
                onDone(null, null, "Could not reach the server: ${e.message ?: e.javaClass.simpleName}")
            }
        }.start()
    }

    override fun onResume() {
        super.onResume()

        // TurfSyncLoginActivity stores the token itself and then closes, so this
        // is where a successful sign-in is noticed. Without it the owner comes
        // back to the setup screen they have just finished with.
        if (config.isConfigured()) {
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }

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
