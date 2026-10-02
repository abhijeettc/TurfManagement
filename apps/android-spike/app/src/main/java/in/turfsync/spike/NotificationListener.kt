package `in`.turfsync.spike

import android.os.BatteryManager
import android.os.Handler
import android.os.HandlerThread
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Reads the owner's own WhatsApp notifications and forwards booking alerts to
 * TurfSync. This is Approach B from the channel-sync research — reading
 * messages the owner already receives, on their own device, with their own
 * consent (granted via notification access) — not automation against a
 * partner platform. Nothing here logs into Playo, Hudle or KheloMore.
 *
 * District, Hudle and KheloMore all deliver bookings as WhatsApp Business
 * messages to the venue owner's own number — confirmed by real capture from
 * Pickle & Pitch Club on 27 Sep 2026 (see packages/parsers/src/templates/).
 * They all arrive under one package, `com.whatsapp`, with the sender's
 * business name as the notification title. That is why this listens to one
 * package rather than guessing at four separate partner-app package names,
 * the way the first version of this file did before that capture happened.
 */
class NotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "TurfSyncListener"
        private const val WHATSAPP_PACKAGE = "com.whatsapp"

        // A cheap client-side pre-filter so an owner's personal chats never
        // leave the phone. The server-side template match (packages/parsers)
        // does the real, precise parse; this only decides what is worth
        // sending at all. Every real captured format contains at least one
        // of these.
        private val BOOKING_HINTS = listOf("booking", "scheduled to play", "game day", "slot:")

        private const val HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000L
        private const val BLOCK_POLL_INTERVAL_MS = 10 * 1000L
        private const val SESSION_CHECK_INTERVAL_MS = 60 * 1000L
    }

    private lateinit var queueFile: File
    private var heartbeatThread: HandlerThread? = null
    private var heartbeatHandler: Handler? = null

    override fun onCreate() {
        super.onCreate()
        queueFile = File(filesDir, "pending-notifications.jsonl")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != WHATSAPP_PACKAGE) return

        val extras = sbn.notification.extras
        val title = extras.getCharSequence("android.title")?.toString().orEmpty()
        val text = extras.getCharSequence("android.text")?.toString().orEmpty()
        // A collapsed notification truncates; bigText is the full body when
        // WhatsApp expands it, which it does for these multi-line alerts.
        val bigText = extras.getCharSequence("android.bigText")?.toString().orEmpty()
        val body = if (bigText.isNotBlank()) bigText else text
        val combined = "$title\n$body"

        if (BOOKING_HINTS.none { combined.contains(it, ignoreCase = true) }) return

        enqueue(combined, sbn.postTime)
        flush()
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        // Deliberately ignored. A dismissed notification is not a cancelled
        // booking — WhatsApp cancellations arrive as their own new message.
    }

    override fun onListenerConnected() {
        Log.i(TAG, "notification access granted — listening on $WHATSAPP_PACKAGE")
        startHeartbeat()
        flush()
    }

    override fun onListenerDisconnected() {
        // Worth knowing about: in production this is a silent capture gap,
        // exactly what device_heartbeats + watchdog.js exist to surface —
        // but the heartbeat itself cannot fire once the listener is gone.
        Log.w(TAG, "notification access LOST — bookings will stop arriving until it is restored")
        stopHeartbeat()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopHeartbeat()
    }

    // ---------------------------------------------------------------- queue
    //
    // The file is the source of truth, same reasoning as the original spike:
    // append first, attempt to send, and only clear what actually made it —
    // a phone with patchy Wi-Fi at the counter must not silently lose a
    // booking because one POST failed.

    @Synchronized
    private fun enqueue(text: String, postedAt: Long) {
        val item = JSONObject()
            .put("text", text)
            .put("postedAt", isoFormat(postedAt))
        queueFile.appendText(item.toString() + "\n")
    }

    @Synchronized
    private fun pendingCount(): Int =
        if (queueFile.exists()) queueFile.readLines().count { it.isNotBlank() } else 0

    private fun flush() {
        val config = DeviceConfig(this)
        if (!config.isConfigured()) return

        val lines = synchronized(this) {
            if (!queueFile.exists() || queueFile.length() == 0L) return
            queueFile.readLines().filter { it.isNotBlank() }
        }
        if (lines.isEmpty()) return

        Thread {
            val sent = postBatch(config, lines)
            if (sent) {
                synchronized(this) { queueFile.writeText("") }
            }
            // On failure the file is left exactly as it was. The next
            // notification, or the next heartbeat tick, retries the batch —
            // there is no separate retry scheduler to get wrong.
        }.start()
    }

    private fun postBatch(config: DeviceConfig, lines: List<String>): Boolean {
        return try {
            val items = JSONArray()
            for (line in lines) items.put(JSONObject(line))
            val body = JSONObject().put("items", items).toString()

            val conn = URL("${config.apiUrl}/ingest/notification").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Device-Token", config.deviceToken)
            conn.doOutput = true
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            conn.disconnect()
            Log.i(TAG, "flushed ${lines.size} item(s) → HTTP $code")
            code in 200..299
        } catch (e: Exception) {
            Log.w(TAG, "flush failed, kept for retry", e)
            false
        }
    }

    // ---------------------------------------------------------------- heartbeat
    //
    // Finding 5 in the build plan: a silent listener looks exactly like a
    // quiet evening. This is what lets watchdog.js tell the difference.

    private fun startHeartbeat() {
        if (heartbeatThread != null) return
        val thread = HandlerThread("turfsync-heartbeat").also { it.start() }
        heartbeatThread = thread
        val handler = Handler(thread.looper)
        heartbeatHandler = handler
        val tick = object : Runnable {
            override fun run() {
                sendHeartbeat()
                handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }
        handler.post(tick)

        val blockTick = object : Runnable {
            override fun run() {
                pollBlockTasks()
                handler.postDelayed(this, BLOCK_POLL_INTERVAL_MS)
            }
        }
        handler.postDelayed(blockTick, BLOCK_POLL_INTERVAL_MS)

        val sessionTick = object : Runnable {
            override fun run() {
                checkSessions()
                handler.postDelayed(this, SESSION_CHECK_INTERVAL_MS)
            }
        }
        handler.postDelayed(sessionTick, 5_000L)
    }

    private fun stopHeartbeat() {
        heartbeatThread?.quitSafely()
        heartbeatThread = null
        heartbeatHandler = null
    }

    private fun sendHeartbeat() {
        val config = DeviceConfig(this)
        if (!config.isConfigured()) return

        Thread {
            try {
                val battery = getSystemService(BATTERY_SERVICE) as BatteryManager
                val pct = battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

                val body = JSONObject()
                    .put("label", "Counter tablet")
                    .put("batteryPct", pct)
                    .put("notificationAccess", true)
                    .put("queuedOffline", pendingCount())
                    .toString()

                val conn = URL("${config.apiUrl}/devices/heartbeat").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("X-Device-Token", config.deviceToken)
                conn.doOutput = true
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.outputStream.use { it.write(body.toByteArray()) }
                conn.responseCode
                conn.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "heartbeat failed", e)
            }
        }.start()
    }

    // ---------------------------------------------------------------- TurfPro block tasks
    //
    // Every 10 s: list the open TurfPro blocks and offer each to BlockQueue (one at a time,
    // in order, no duplicates). While TurfPro is signed out nothing is run — the once-a-minute
    // session check below nags the owner, and the first 10 s poll after they sign in queues the
    // waiting tasks again.

    private val blockQueue by lazy { BlockQueue(this) }

    private fun isPast(task: JSONObject): Boolean = try {
        val start = java.time.LocalDate.parse(task.optString("date"))
            .atTime(java.time.LocalTime.parse(task.optString("from")))
            .atZone(java.time.ZoneId.of("Asia/Kolkata"))
        !start.toInstant().isAfter(java.time.Instant.now())
    } catch (e: Exception) {
        false
    }

    private fun pollBlockTasks() {
        val config = DeviceConfig(this)
        if (!config.isConfigured()) return
        try {
            val conn = URL("${config.apiUrl}/status.json").openConnection() as HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            val json = try {
                if (conn.responseCode !in 200..299) return
                conn.inputStream.bufferedReader().use { it.readText() }
            } finally {
                conn.disconnect()
            }
            val tasks = JSONObject(json).optJSONArray("tasks") ?: return
            val signedIn = SessionMonitor.hasCookie(this, "turfpro")
            for (i in 0 until tasks.length()) {
                val task = tasks.getJSONObject(i)
                if (task.optString("kind") != "awaiting_browser" || task.optString("platform") != "turfpro") continue
                val id = task.optString("id")
                if (BlockNotifier.gaveUpNotified(this, id)) continue

                // TurfPro only blocks future slots, so a past one can never succeed: say so now instead of timing out.
                if (isPast(task)) {
                    TurfProRunner.report(this, "browser-failed", id, "failed", "That slot's time has already passed, so TurfPro cannot block it")
                    BlockNotifier.markGaveUpNotified(this, id)
                    continue
                }

                if (!signedIn) {
                    if (!task.optBoolean("loginNeeded")) TurfProRunner.report(this, "browser-login-needed", id)
                    continue
                }

                if (BlockNotifier.due(this, id)) {
                    blockQueue.offer(task)
                } else if (BlockNotifier.exhausted(this, id)) {
                    TurfProRunner.report(this, "browser-failed", id, "failed", "TurfSync could not complete the block in TurfPro after several tries")
                    BlockNotifier.notifyGaveUp(this, task)
                    BlockNotifier.markGaveUpNotified(this, id)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "block task poll failed", e)
        }
    }

    // ---------------------------------------------------------------- sign-in check
    //
    // Once a minute, for every app that is signed in inside TurfSync: still signed in?
    // If not, a "Sign in" notification is posted again each minute until they do.

    private fun checkSessions() {
        for ((platform, label) in SessionMonitor.PLATFORMS) {
            when (SessionMonitor.check(this, platform)) {
                SessionMonitor.State.OUT -> BlockNotifier.notifySessionOut(this, label)
                SessionMonitor.State.IN -> BlockNotifier.clearSessionNotice(this, label)
                SessionMonitor.State.UNKNOWN -> Unit
            }
        }
    }

    private fun isoFormat(ms: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.UK)
        fmt.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return fmt.format(Date(ms))
    }
}
