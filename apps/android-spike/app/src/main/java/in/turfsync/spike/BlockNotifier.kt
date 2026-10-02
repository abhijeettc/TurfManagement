package `in`.turfsync.spike

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/**
 * Bookkeeping and notifications for hands-free TurfPro blocking. The blocking
 * itself is [TurfProRunner]; this remembers which tasks were already tried (so
 * a task isn't re-run every poll) and tells the owner when they have to sign in.
 */
object BlockNotifier {
    private const val CHANNEL = "turfsync_blocks"
    private const val PREFS = "turfsync_blocks"

    private const val RETRY_MS = 30_000L
    private const val MAX_TRIES = 6

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---------------------------------------------------------------- attempts

    fun tries(context: Context, id: String): Int = prefs(context).getInt("tries_$id", 0)

    /** Never tried, or tried before and the retry delay has passed (and it is still within the retry budget). */
    fun due(context: Context, id: String): Boolean {
        val p = prefs(context)
        val n = p.getInt("tries_$id", 0)
        if (n == 0) return true
        return n < MAX_TRIES && System.currentTimeMillis() - p.getLong("last_$id", 0L) >= RETRY_MS
    }

    fun markTried(context: Context, id: String) {
        val p = prefs(context)
        p.edit().putInt("tries_$id", p.getInt("tries_$id", 0) + 1).putLong("last_$id", System.currentTimeMillis()).apply()
    }

    fun exhausted(context: Context, id: String) = tries(context, id) >= MAX_TRIES

    fun gaveUpNotified(context: Context, id: String) = prefs(context).getBoolean("gaveup_$id", false)
    fun markGaveUpNotified(context: Context, id: String) = prefs(context).edit().putBoolean("gaveup_$id", true).apply()

    // ---------------------------------------------------------------- notifications

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Slot blocking", NotificationManager.IMPORTANCE_HIGH))
        }
    }

    private fun slotText(task: JSONObject) =
        "${task.optString("court")} · ${task.optString("date")} ${task.optString("from")}–${task.optString("to")}"

    /**
     * Posted again every minute for as long as the owner is signed out of [label] inside TurfSync,
     * and cancelled the moment they are signed in. Blocking resumes on its own afterwards.
     */
    fun notifySessionOut(context: Context, label: String) {
        val open = Intent(context, TurfProLoginActivity::class.java)
            .putExtra(TurfProLoginActivity.EXTRA_FINISH_ON_LOGIN, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        post(
            context, "session$label".hashCode(), open,
            "Sign in to $label",
            "TurfSync is signed out of $label, so bookings cannot be blocked there. Tap to sign in.",
        )
    }

    fun clearSessionNotice(context: Context, label: String) {
        context.getSystemService(NotificationManager::class.java).cancel("session$label".hashCode())
    }

    fun notifyGaveUp(context: Context, task: JSONObject) {
        val id = task.optString("id")
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        post(
            context, ("gaveup$id").hashCode(), open,
            "Could not block on TurfPro",
            "${slotText(task)} could not be blocked automatically. Please block it in TurfPro yourself.",
        )
    }

    private fun post(context: Context, notificationId: Int, open: Intent, title: String, text: String) {
        ensureChannel(context)
        val pending = PendingIntent.getActivity(
            context, notificationId, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, CHANNEL)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(context)
        }
        context.getSystemService(NotificationManager::class.java).notify(
            notificationId,
            builder
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setContentIntent(pending)
                .setWhen(System.currentTimeMillis())
                .setAutoCancel(true)
                .build(),
        )
    }
}
