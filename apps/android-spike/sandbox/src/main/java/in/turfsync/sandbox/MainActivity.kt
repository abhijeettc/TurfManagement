package `in`.turfsync.sandbox

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Notification
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.TextView
import android.view.ViewGroup
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var apiUrl: EditText
    private lateinit var deviceToken: EditText
    private lateinit var platform: Spinner
    private lateinit var status: TextView
    private lateinit var slotState: TextView
    private val blocked = mutableSetOf<String>()
    private val dateFormat = SimpleDateFormat("dd MMM yy", Locale.UK)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createNotificationChannel()
        setContentView(buildView())
    }

    private fun buildView(): LinearLayout {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }
        root.addView(TextView(this).apply {
            text = "TurfSync Sandbox Partner\nDeterministic test data only"
            textSize = 22f
        }, weight(0))
        apiUrl = input("API URL", "http://192.168.1.34:3000")
        deviceToken = input("Device token", "")
        root.addView(apiUrl)
        root.addView(deviceToken)
        platform = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, arrayOf("khelomore", "playo"))
        }
        root.addView(platform, weight(0))
        root.addView(button("Send booking notification") { sendNotification() })
        root.addView(button("Send booking to TurfSync API") { sendToApi() })
        root.addView(button("Send cancellation to TurfSync API") { sendCancellation() })
        root.addView(TextView(this).apply { text = "Sandbox calendar"; textSize = 18f })
        root.addView(button("Block Court 1 · today 19:00–20:00") { setBlocked(true) })
        root.addView(button("Unblock Court 1 · today 19:00–20:00") { setBlocked(false) })
        slotState = TextView(this)
        root.addView(slotState)
        status = TextView(this)
        root.addView(status)
        updateState()
        return root
    }

    private fun input(label: String, value: String) = EditText(this).apply {
        hint = label
        setText(value)
        singleLine = true
    }

    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { action() }
    }

    private fun weight(height: Int) = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        if (height == 0) ViewGroup.LayoutParams.WRAP_CONTENT else height,
    )

    private fun sendNotification() {
        val selected = platform.selectedItem as String
        val text = bookingText(selected)
        val manager = getSystemService(NotificationManager::class.java)
        val notification = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(if (selected == "khelomore") "KheloMore" else "Playo")
                .setContentText(text.lines().first())
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setPriority(Notification.PRIORITY_HIGH)
                .build()
        } else {
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(if (selected == "khelomore") "KheloMore" else "Playo")
                .setContentText(text.lines().first())
                .setPriority(Notification.PRIORITY_HIGH)
                .build()
        }
        manager.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), notification)
        status.text = "Notification sent. A real listener would capture it."
    }

    private fun sendToApi() = postPayload(bookingText(platform.selectedItem as String), "booking")

    private fun sendCancellation() = postPayload(bookingText(platform.selectedItem as String, cancelled = true), "cancellation")

    private fun bookingText(selected: String, cancelled: Boolean = false): String {
        val day = dateFormat.format(Date())
        return if (selected == "khelomore") {
            "KheloMore\n${if (cancelled) "Booking Cancelled" else "New Booking Alert"}\n" +
                "A new booking has been received at TurfSync Sandbox.\n" +
                "Customer: Sandbox Customer\nGame Day: $day\nSlot: 07:00 PM - 08:00 PM\n" +
                "Property: Court 1\nAmount Paid: 637.0\nBooking ID: KM-SANDBOX-001"
        } else {
            "Playo\n${if (cancelled) "Booking Cancelled" else "New Booking Confirmed"}\n" +
                "Court 1 · $day\n07:00 PM - 08:00 PM\nSandbox Customer\nBooking ID: PLY-SANDBOX-001"
        }
    }

    private fun postPayload(text: String, kind: String) {
        val token = deviceToken.text.toString().trim()
        if (token.isBlank()) { status.text = "Enter the TurfSync device token first."; return }
        thread {
            try {
                val body = JSONObject().put("items", org.json.JSONArray().put(JSONObject()
                    .put("text", text).put("platform", platform.selectedItem as String)
                    .put("postedAt", "${SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.UK).format(Date())}"))).toString()
                val connection = URL("${apiUrl.text.toString().trimEnd('/')}/ingest/notification").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("X-Device-Token", token)
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray()) }
                val response = connection.responseCode
                runOnUiThread { status.text = "$kind API response: $response\n${text.lines().first()}" }
                connection.disconnect()
            } catch (error: Exception) {
                runOnUiThread { status.text = "$kind failed: ${error.message}" }
            }
        }
    }

    private fun setBlocked(value: Boolean) {
        val key = "Court 1|19:00-20:00"
        if (value) blocked.add(key) else blocked.remove(key)
        updateState()
    }

    private fun updateState() {
        if (!::slotState.isInitialized) return
        slotState.text = if (blocked.contains("Court 1|19:00-20:00")) "Court 1 · 19:00–20:00 · BLOCKED" else "Court 1 · 19:00–20:00 · AVAILABLE"
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Sandbox bookings", NotificationManager.IMPORTANCE_HIGH),
            )
        }
    }

    companion object { private const val CHANNEL = "sandbox-bookings" }
}
