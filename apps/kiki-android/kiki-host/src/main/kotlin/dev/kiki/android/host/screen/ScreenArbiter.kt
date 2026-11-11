package dev.kiki.android.host.screen

import dev.kiki.android.host.i18n.HostStrings
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.Locale

enum class ArbiterState {
    IDLE,
    LEASED,
    PAUSED,
}

enum class ScreenToolRole {
    NONE,
    READ,
    SCREENSHOT,
    ACT,
}

sealed interface ArbiterGateOutcome {
    data object Proceed : ArbiterGateOutcome
    data class Blocked(val code: String, val message: String, val retryable: Boolean) : ArbiterGateOutcome {
        fun toJson(): JsonObject = buildJsonObject {
            put("ok", false)
            put("error", code)
            put("message", message)
            put("retryable", retryable)
        }
    }
}

class ScreenArbiter(
    private val selfPackage: String,
    private val foregroundPackageProvider: () -> String?,
    private val isSplitScreenCoexisting: () -> Boolean = { false },
    private val yieldSelfToBackground: () -> Boolean,
    private val pill: PillOverlayController,
    private val isChineseProvider: () -> Boolean = { HostStrings.isChinese(Locale.getDefault()) },
    private val roleClassifier: ((toolName: String, argumentsJson: String) -> ScreenToolRole?)? = null,
    private val auditLogFile: File? = null,
    private val yieldTimeoutMs: Long = 3_000L,
    private val pollIntervalMs: Long = 50L,
    private val leaseDurationMs: Long = 30_000L,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()

    @Volatile
    var state: ArbiterState = ArbiterState.IDLE
        private set

    @Volatile
    private var leaseExpiresAtMs: Long = 0L

    fun classifyTool(toolName: String, argumentsJson: String = ""): ScreenToolRole {
        roleClassifier?.invoke(toolName, argumentsJson)?.let { return it }
        return defaultClassifyTool(toolName, argumentsJson)
    }

    fun onUserReturnedToKiki() {
        if (state == ArbiterState.LEASED || state == ArbiterState.PAUSED) {
            val wasLeased = state == ArbiterState.LEASED
            state = ArbiterState.PAUSED
            pill.hide()
            if (wasLeased) {
                appendAudit("state=PAUSED reason=user_returned")
            }
        }
    }

    fun onUserLeftKikiWhilePaused() {
        if (state == ArbiterState.PAUSED) {
            pill.showOrUpdate(HostStrings.pillPausedStatus(isChineseProvider()), paused = true)
        }
    }

    fun resumeFromUserOrNewTurn() {
        if (state == ArbiterState.PAUSED) {
            state = ArbiterState.IDLE
            pill.hide()
            appendAudit("state=IDLE reason=resumed")
        }
    }

    fun onTurnsIdle() {
        val now = clock()
        if (state == ArbiterState.LEASED && now >= leaseExpiresAtMs) {
            release()
        }
    }

    fun release() {
        state = ArbiterState.IDLE
        leaseExpiresAtMs = 0L
        pill.hide()
        appendAudit("state=IDLE reason=released")
    }

    suspend fun <T> withArbitration(
        toolName: String,
        argumentsJson: String,
        block: suspend () -> T,
        onBlocked: (ArbiterGateOutcome.Blocked) -> T,
    ): T {
        val role = classifyTool(toolName, argumentsJson)
        if (role == ScreenToolRole.NONE) {
            return block()
        }

        val gate = beforeScreenTool(toolName, role)
        if (gate is ArbiterGateOutcome.Blocked) {
            return onBlocked(gate)
        }

        if (role == ScreenToolRole.SCREENSHOT) {
            pill.setHiddenForScreenshot(true)
        } else if (role == ScreenToolRole.ACT) {
            pill.setGesturePassThrough(true)
        }

        return try {
            val result = block()
            val afterPkg = foregroundPackageProvider()
            appendAudit("executed tool=$toolName role=$role fgAfter=${afterPkg ?: "unknown"}")
            result
        } finally {
            if (role == ScreenToolRole.SCREENSHOT) {
                pill.setHiddenForScreenshot(false)
            } else if (role == ScreenToolRole.ACT) {
                pill.setGesturePassThrough(false)
            }
            mutex.withLock {
                if (state != ArbiterState.PAUSED) {
                    state = ArbiterState.LEASED
                    leaseExpiresAtMs = clock() + leaseDurationMs
                }
            }
        }
    }

    private suspend fun beforeScreenTool(toolName: String, role: ScreenToolRole): ArbiterGateOutcome = mutex.withLock {
        if (state == ArbiterState.PAUSED) {
            appendAudit("blocked tool=$toolName code=user_in_kiki_paused")
            return@withLock ArbiterGateOutcome.Blocked(
                code = "user_in_kiki_paused",
                message = "User returned to Kiki and paused screen automation. Wait for user instruction before touching the screen.",
                retryable = false,
            )
        }

        val currentFg = foregroundPackageProvider()
        val splitCoexist = isSplitScreenCoexisting()
        if (currentFg == selfPackage && !splitCoexist) {
            pill.showOrUpdate(stepLabel(toolName))
            val initiated = yieldSelfToBackground()
            val deadline = clock() + yieldTimeoutMs
            var observedFg = foregroundPackageProvider()
            while (observedFg == selfPackage && clock() < deadline) {
                delay(pollIntervalMs)
                observedFg = foregroundPackageProvider()
            }
            if (observedFg == selfPackage) {
                val code = if (initiated) "screen_yield_timeout" else "self_target_blocked"
                appendAudit("blocked tool=$toolName code=$code fg=$observedFg")
                return@withLock ArbiterGateOutcome.Blocked(
                    code = code,
                    message = "Kiki is still in the foreground ($selfPackage); refusing to read or act on its own window.",
                    retryable = initiated,
                )
            }
            appendAudit("yielded tool=$toolName from=$selfPackage to=${observedFg ?: "launcher"}")
        } else {
            pill.showOrUpdate(stepLabel(toolName))
        }

        val verifiedFg = foregroundPackageProvider()
        if (verifiedFg == selfPackage && !isSplitScreenCoexisting()) {
            appendAudit("blocked tool=$toolName code=self_target_blocked fg=$verifiedFg")
            return@withLock ArbiterGateOutcome.Blocked(
                code = "self_target_blocked",
                message = "Refusing screen tool $toolName while Kiki ($selfPackage) is foreground.",
                retryable = false,
            )
        }

        state = ArbiterState.LEASED
        leaseExpiresAtMs = clock() + leaseDurationMs
        ArbiterGateOutcome.Proceed
    }

    internal fun stepLabel(toolName: String): String =
        HostStrings.stepLabel(toolName, isChineseProvider())

    private fun appendAudit(line: String) {
        val file = auditLogFile ?: return
        runCatching {
            file.parentFile?.mkdirs()
            file.appendText("${clock()} $line\n", StandardCharsets.UTF_8)
        }
    }

    companion object {
        fun defaultClassifyTool(toolName: String, argumentsJson: String = ""): ScreenToolRole {
            if (toolName in SCREENSHOT_TOOLS) return ScreenToolRole.SCREENSHOT
            if (toolName == "phone_observe" && argumentsJson.contains("\"withImage\":true")) {
                return ScreenToolRole.SCREENSHOT
            }
            if (toolName in READ_TOOLS) return ScreenToolRole.READ
            if (toolName in ACT_TOOLS) return ScreenToolRole.ACT
            return ScreenToolRole.NONE
        }

        val SCREENSHOT_TOOLS = setOf(
            "phone_screenshot",
            "phone_describe",
            "phone_find_visually",
        )

        val READ_TOOLS = setOf(
            "phone_observe",
            "phone_list_elements",
            "phone_diagnose",
            "phone_query",
            "phone_extract",
            "phone_wait",
            "phone_event",
        )

        val ACT_TOOLS = setOf(
            "phone_tap",
            "phone_scroll",
            "phone_swipe",
            "phone_gesture",
            "phone_type_text",
            "phone_clear_text",
            "phone_back",
            "phone_press_key",
            "phone_find",
            "phone_collect",
            "phone_dialog",
            "phone_set_wheel",
            "phone_launch_app",
            "phone_open_link",
            "phone_run",
        )
    }
}
