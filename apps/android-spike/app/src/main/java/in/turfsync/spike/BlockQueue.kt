package `in`.turfsync.spike

import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * Runs TurfPro block tasks one at a time, in the order they arrived.
 *
 * The poller offers every open task every few seconds; a task already waiting
 * or running is ignored, so repeated polls never pile up duplicates, and the
 * queue is capped so a flood of bookings can't exhaust the tablet. Everything
 * touching the queue happens on the main thread (the WebView needs it anyway).
 */
class BlockQueue(context: Context) {
    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val pending = ArrayDeque<JSONObject>()
    private val queued = HashSet<String>()
    private var running: String? = null

    /** Safe to call from any thread. */
    fun offer(task: JSONObject) {
        main.post {
            val id = task.optString("id")
            if (id.isEmpty() || id == running || id in queued || pending.size >= MAX_QUEUED) return@post
            queued.add(id)
            pending.addLast(task)
            next()
        }
    }

    private fun next() {
        if (running != null) return
        val task = pending.removeFirstOrNull() ?: return
        val id = task.optString("id")
        queued.remove(id)
        running = id

        TurfProRunner(appContext, task) { result ->
            handle(task, result)
            running = null
            next()
        }.start()
    }

    private fun handle(task: JSONObject, result: TurfProRunner.Result) {
        val id = task.optString("id")
        when (result) {
            TurfProRunner.Result.DONE -> {
                TurfProRunner.report(appContext, "browser-done", id)
            }
            TurfProRunner.Result.LOGIN_NEEDED -> {
                // The page sent us to the login: whatever cookie we held is dead. Dropping it turns the
                // status red and the minute-by-minute check nags the owner until they sign in again.
                SessionMonitor.clear(appContext)
                TurfProRunner.report(appContext, "browser-login-needed", id)
            }
            // A customer already holds the slot in TurfPro: never touched; shown as a double booking.
            TurfProRunner.Result.BOOKED -> {
                TurfProRunner.report(appContext, "browser-failed", id, "already_booked", "This slot already has a booking in TurfPro, so it was not touched")
                BlockNotifier.markGaveUpNotified(appContext, id)
            }
            TurfProRunner.Result.NO_SLOT -> {
                TurfProRunner.report(appContext, "browser-failed", id, "failed", "TurfPro has no such slot on that date (outside the ground's operating hours?)")
                BlockNotifier.markGaveUpNotified(appContext, id)
            }
            // Counted against the retry budget; the poller offers it again after a short pause.
            TurfProRunner.Result.FAILED -> BlockNotifier.markTried(appContext, id)
        }
    }

    companion object {
        private const val MAX_QUEUED = 50
    }
}
