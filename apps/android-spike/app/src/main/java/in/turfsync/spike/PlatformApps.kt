package `in`.turfsync.spike

import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Opens a partner platform's own app so staff can do the block/unblock
 * themselves — see blocking/worker.js on the server. This only launches the
 * app; it never touches its UI or logs in on anyone's behalf. Equivalent to
 * the owner tapping the app icon themselves, just skipping the hunt for it.
 *
 * Partner/owner-app package names (not the consumer apps — those don't have
 * a block-slot screen). District's is not yet known, so it is omitted; call
 * sites should treat a missing entry as "no shortcut available."
 */
object PlatformApps {
    private val PACKAGES = mapOf(
        "playo" to "com.techmash.playobooking",
        "hudle" to "com.hudle.partner.app",
        "khelomore" to "com.khelomore.pnp.vendor",
    )

    fun packageFor(platform: String): String? = PACKAGES[platform.lowercase()]

    /**
     * TurfPro is a web app, not an Android package, hosted at whatever address
     * DeviceConfig.turfProUrl names — not necessarily the same host as the
     * TurfSync server. It opens inside TurfSync (not the browser) so the
     * session TurfSync's automatic blocking uses is the one the owner signs in
     * to here. Still only a launch; nothing is done inside it.
     */
    private fun openTurfPro(context: Context): Boolean {
        if (DeviceConfig(context).turfProUrl.isBlank()) return false
        context.startActivity(Intent(context, TurfProLoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return true
    }

    /** Launches the app if installed, otherwise its Play Store listing. */
    fun open(context: Context, platform: String): Boolean {
        if (platform.equals("turfpro", ignoreCase = true)) return openTurfPro(context)
        val pkg = packageFor(platform) ?: return false

        val launchIntent = context.packageManager.getLaunchIntentForPackage(pkg)
        if (launchIntent != null) {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(launchIntent)
            return true
        }

        return try {
            context.startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
        } catch (e: android.content.ActivityNotFoundException) {
            // No Play Store app either (rare, but possible on a stripped-down
            // tablet build) — nothing left to hand off to.
            false
        }
    }
}
