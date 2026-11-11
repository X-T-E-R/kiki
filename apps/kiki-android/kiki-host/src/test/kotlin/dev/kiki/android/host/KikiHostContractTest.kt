package dev.kiki.android.host

import dev.kiki.android.host.gateway.HostGateway
import dev.kiki.android.host.gateway.KeystoreSecretBroker
import dev.kiki.android.host.gateway.KikiToolProxy
import dev.kiki.android.host.gateway.McpBackendAdapter
import dev.kiki.android.host.i18n.HostStrings
import dev.kiki.android.host.screen.ArbiterState
import dev.kiki.android.host.screen.OverlayPill
import dev.kiki.android.host.screen.PillOverlayController
import dev.kiki.android.host.screen.ScreenArbiter
import dev.kiki.android.host.ui.AndroidBridgeHandler
import dev.kiki.android.host.ui.KikiWebActivity
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Test
import java.io.File
import java.nio.file.Files
import javax.crypto.KeyGenerator
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KikiHostContractTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private class FakePill : PillOverlayController {
        override var isShowing: Boolean = false
        var lastStatus: String = ""
        var pausedFlag: Boolean = false
        var passThrough: Boolean = false
        var hiddenForShotCount: Int = 0
        var currentlyHidden: Boolean = false

        override fun showOrUpdate(statusText: String, paused: Boolean) {
            isShowing = true
            lastStatus = statusText
            pausedFlag = paused
        }

        override fun setGesturePassThrough(passThrough: Boolean) {
            this.passThrough = passThrough
        }

        override suspend fun setHiddenForScreenshot(hidden: Boolean) {
            if (hidden) hiddenForShotCount++
            currentlyHidden = hidden
        }

        override fun hide() {
            isShowing = false
        }
    }

    @Test
    fun keystoreSecretBroker_encrypts_persists_and_isolates_aad() {
        val dir = Files.createTempDirectory("kiki-secret-test").toFile()
        try {
            val vaultFile = File(dir, "secrets.bin")
            val secretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            val broker = KeystoreSecretBroker(vaultFile) { secretKey }

            assertNull(broker.get("kiki.provider.openai", "default"))
            broker.put("kiki.provider.openai", "default", "sk-super-secret-value-991")
            broker.put("kiki.provider.openai", "work", "sk-work-key-222")

            assertEquals("sk-super-secret-value-991", broker.get("kiki.provider.openai", "default"))
            assertEquals(listOf("default", "work"), broker.listAccounts("kiki.provider.openai"))

            val rawDisk = vaultFile.readText()
            assertFalse(rawDisk.contains("sk-super-secret-value-991"), "Plaintext secret must never be written to disk")

            // Reload from a fresh instance with the same key
            val brokerReloaded = KeystoreSecretBroker(vaultFile) { secretKey }
            assertEquals("sk-work-key-222", brokerReloaded.get("kiki.provider.openai", "work"))

            assertTrue(brokerReloaded.delete("kiki.provider.openai", "default"))
            assertNull(brokerReloaded.get("kiki.provider.openai", "default"))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun kikiToolProxy_blocks_mika_run_task_with_minus_32601_and_filters_wake_unlock() = runTest {
        val pill = FakePill()
        val arbiter = ScreenArbiter(
            selfPackage = "com.wangzan101.mika",
            foregroundPackageProvider = { "com.android.settings" },
            yieldSelfToBackground = { true },
            pill = pill,
        )
        var wakeAllowed = false
        val backend = object : McpBackendAdapter {
            override fun listTools(): List<HostMcpToolDescriptor> = listOf(
                HostMcpToolDescriptor("phone_observe", "Observe screen", """{"type":"object"}"""),
                HostMcpToolDescriptor("phone_tap", "Tap element", """{"type":"object"}"""),
                HostMcpToolDescriptor("mika_device_state", "Device state", """{"type":"object"}"""),
                HostMcpToolDescriptor("mika_run_task", "Legacy Kotlin agent", """{"type":"object"}"""),
                HostMcpToolDescriptor("mika_wake_device", "Wake screen", """{"type":"object"}"""),
                HostMcpToolDescriptor("mika_unlock_device", "Unlock screen", """{"type":"object"}"""),
                HostMcpToolDescriptor("phone_command", "Shell command", """{"type":"object"}"""),
            )

            override fun allowWakeUnlock(): Boolean = wakeAllowed
            override fun isAttended(): Boolean = true
            override suspend fun callTool(name: String, argumentsJson: String, attended: Boolean): HostMcpToolCallResult {
                return HostMcpToolCallResult(buildJsonObject { put("ok", true); put("tool", name) })
            }
        }

        val proxy = KikiToolProxy(backend, arbiter, "0.1.39")

        val listResp = proxy.handleJsonRpc("""{"jsonrpc":"2.0","id":1,"method":"tools/list"}""")!!.jsonObject
        val listedNames = listResp["result"]!!.jsonObject["tools"]!!.jsonArray
            .map { it.jsonObject["name"]!!.jsonPrimitive.content }

        assertEquals(listOf("phone_observe", "phone_tap", "mika_device_state"), listedNames)
        assertFalse("mika_run_task" in listedNames)
        assertFalse("mika_wake_device" in listedNames)
        assertFalse("phone_command" in listedNames)

        // Calling mika_run_task must return JSON-RPC -32601
        val blockedResp = proxy.handleJsonRpc(
            """{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mika_run_task","arguments":{"goal":"hi"}}}""",
        )!!.jsonObject
        assertEquals(-32601, blockedResp["error"]!!.jsonObject["code"]!!.jsonPrimitive.intOrNull)

        // Enabling allowWakeUnlock exposes mika_wake_device & mika_unlock_device, still never mika_run_task
        wakeAllowed = true
        val listAfterOptIn = proxy.handleJsonRpc("""{"jsonrpc":"2.0","id":3,"method":"tools/list"}""")!!.jsonObject
        val namesAfterOptIn = listAfterOptIn["result"]!!.jsonObject["tools"]!!.jsonArray
            .map { it.jsonObject["name"]!!.jsonPrimitive.content }
        assertTrue("mika_wake_device" in namesAfterOptIn)
        assertTrue("mika_unlock_device" in namesAfterOptIn)
        assertFalse("mika_run_task" in namesAfterOptIn)
    }

    @Test
    fun screenArbiter_yields_self_hides_pill_on_screenshot_and_pauses_on_user_return() = runTest {
        var currentFg = "com.wangzan101.mika"
        var yieldCalled = 0
        val pill = FakePill()
        val auditFile = Files.createTempFile("screen-audit", ".log").toFile()
        try {
            val arbiter = ScreenArbiter(
                selfPackage = "com.wangzan101.mika",
                foregroundPackageProvider = { currentFg },
                yieldSelfToBackground = {
                    yieldCalled++
                    currentFg = "com.android.launcher3"
                    true
                },
                pill = pill,
                auditLogFile = auditFile,
                pollIntervalMs = 10L,
            )

            // 1. Tap while Kiki is foreground -> yields to launcher, sets passThrough during execution
            var passThroughDuringAct = false
            val tapOut = arbiter.withArbitration(
                toolName = "phone_tap",
                argumentsJson = """{"ref":"@e1"}""",
                block = {
                    passThroughDuringAct = pill.passThrough
                    "ok_tap"
                },
                onBlocked = { "blocked:${it.code}" },
            )
            assertEquals("ok_tap", tapOut)
            assertEquals(1, yieldCalled)
            assertTrue(passThroughDuringAct, "OverlayPill must enable FLAG_NOT_TOUCHABLE during gesture execution")
            assertFalse(pill.passThrough, "OverlayPill must restore touchability after gesture")
            assertEquals(ArbiterState.LEASED, arbiter.state)

            // 2. Screenshot hides pill before capture and restores after
            var hiddenInsideShot = false
            arbiter.withArbitration(
                toolName = "phone_screenshot",
                argumentsJson = "{}",
                block = {
                    hiddenInsideShot = pill.currentlyHidden
                    "ok_shot"
                },
                onBlocked = { "blocked" },
            )
            assertTrue(hiddenInsideShot)
            assertFalse(pill.currentlyHidden)
            assertEquals(1, pill.hiddenForShotCount)

            // 3. User returns to Kiki -> PAUSED, pill hides while user is inside Kiki, subsequent screen calls blocked
            arbiter.onUserReturnedToKiki()
            assertEquals(ArbiterState.PAUSED, arbiter.state)
            assertFalse(pill.isShowing, "Pill must hide when user is already inside Kiki")
            val pausedOut = arbiter.withArbitration(
                toolName = "phone_observe",
                argumentsJson = "{}",
                block = { "unexpected" },
                onBlocked = { it.code },
            )
            assertEquals("user_in_kiki_paused", pausedOut)

            // 4. If user leaves Kiki while paused, paused pill is shown and resumeFromUserOrNewTurn clears it
            arbiter.onUserLeftKikiWhilePaused()
            assertTrue(pill.isShowing)
            assertTrue(pill.pausedFlag)
            arbiter.resumeFromUserOrNewTurn()
            assertEquals(ArbiterState.IDLE, arbiter.state)
            assertFalse(pill.isShowing)

            val auditText = auditFile.readText()
            assertTrue(auditText.contains("yielded tool=phone_tap"))
            assertTrue(auditText.contains("blocked tool=phone_observe code=user_in_kiki_paused"))
            assertTrue(auditText.contains("state=IDLE reason=resumed"))
        } finally {
            auditFile.delete()
        }
    }

    @Test
    fun androidBridgeDispatch_supports_openPhoneSettings_and_setAppearance() {
        var phoneSettingsOpened = 0
        var lastDarkAppearance: Boolean? = null

        val openPhoneRes = AndroidBridgeHandler.dispatchMethod(
            method = "openPhoneSettings",
            params = buildJsonObject {},
            capabilitiesProvider = { buildJsonObject { put("platform", "android") } },
            openPermission = {},
            openNativePhoneSettings = { phoneSettingsOpened++ },
            setAppearance = { dark -> lastDarkAppearance = dark },
            setAllowWakeUnlock = {},
            resumeScreenAutomation = {},
            readClipboard = { null },
            writeClipboard = {},
            shareText = {},
        ).jsonObject
        assertEquals(1, phoneSettingsOpened)
        assertEquals("native_settings", openPhoneRes["opened"]?.jsonPrimitive?.contentOrNull)

        AndroidBridgeHandler.dispatchMethod(
            method = "setAppearance",
            params = buildJsonObject { put("dark", true) },
            capabilitiesProvider = { buildJsonObject {} },
            openPermission = {},
            openNativePhoneSettings = {},
            setAppearance = { dark -> lastDarkAppearance = dark },
            setAllowWakeUnlock = {},
            resumeScreenAutomation = {},
            readClipboard = { null },
            writeClipboard = {},
            shareText = {},
        )
        assertEquals(true, lastDarkAppearance)

        AndroidBridgeHandler.dispatchMethod(
            method = "setAppearance",
            params = buildJsonObject { put("dark", false) },
            capabilitiesProvider = { buildJsonObject {} },
            openPermission = {},
            openNativePhoneSettings = {},
            setAppearance = { dark -> lastDarkAppearance = dark },
            setAllowWakeUnlock = {},
            resumeScreenAutomation = {},
            readClipboard = { null },
            writeClipboard = {},
            shareText = {},
        )
        assertEquals(false, lastDarkAppearance)
    }

    @Test
    fun bilingualLabels_and_pillTouchTargetContract() = runTest {
        var zhMode = false
        val pill = FakePill()
        val arbiter = ScreenArbiter(
            selfPackage = "com.wangzan101.mika",
            foregroundPackageProvider = { "com.android.settings" },
            yieldSelfToBackground = { true },
            pill = pill,
            isChineseProvider = { zhMode },
        )

        arbiter.withArbitration(
            toolName = "phone_observe",
            argumentsJson = "{}",
            block = { "ok" },
            onBlocked = { "blocked" },
        )
        assertEquals("Kiki is viewing the screen", pill.lastStatus)
        assertEquals("Back", HostStrings.pillBackAction(false))
        assertEquals("Resume", HostStrings.pillResumeAction(false))
        assertEquals("Stop", HostStrings.pillStopAction(false))
        assertEquals("Kiki is tapping", arbiter.stepLabel("phone_tap"))
        assertEquals("Kiki is scrolling", arbiter.stepLabel("phone_scroll"))
        assertEquals("Kiki is typing", arbiter.stepLabel("phone_type_text"))
        assertEquals("Kiki is opening an app", arbiter.stepLabel("phone_launch_app"))

        arbiter.onUserReturnedToKiki()
        arbiter.onUserLeftKikiWhilePaused()
        assertEquals("Kiki screen actions paused", pill.lastStatus)
        arbiter.resumeFromUserOrNewTurn()

        zhMode = true
        arbiter.withArbitration(
            toolName = "phone_observe",
            argumentsJson = "{}",
            block = { "ok" },
            onBlocked = { "blocked" },
        )
        assertEquals("Kiki 正在查看屏幕", pill.lastStatus)
        assertEquals("返回", HostStrings.pillBackAction(true))
        assertEquals("继续", HostStrings.pillResumeAction(true))
        assertEquals("停止", HostStrings.pillStopAction(true))

        assertTrue(OverlayPill.MIN_TOUCH_TARGET_DP >= 48)
    }

    @Test
    fun hostGateway_end_to_end_http_auth_for_secret_and_mcp() {
        val dir = Files.createTempDirectory("kiki-gw-test").toFile()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val broker = KeystoreSecretBroker(File(dir, "secrets.bin")) { key }
        val pill = FakePill()
        val arbiter = ScreenArbiter(
            selfPackage = "com.wangzan101.mika",
            foregroundPackageProvider = { "com.android.settings" },
            yieldSelfToBackground = { true },
            pill = pill,
        )
        val proxy = KikiToolProxy(
            backend = object : McpBackendAdapter {
                override fun listTools() = listOf(
                    HostMcpToolDescriptor("phone_list_apps", "List apps", """{"type":"object"}"""),
                    HostMcpToolDescriptor("mika_run_task", "Blocked", """{"type":"object"}"""),
                )
                override fun allowWakeUnlock() = false
                override fun isAttended() = true
                override suspend fun callTool(name: String, argumentsJson: String, attended: Boolean) =
                    HostMcpToolCallResult(buildJsonObject { put("ok", true); put("apps", 12) })
            },
            arbiter = arbiter,
        )

        val secretToken = "sec-token-123"
        val mcpToken = "mcp-token-456"
        val gateway = HostGateway(
            secretTokenProvider = { secretToken },
            mcpTokenProvider = { mcpToken },
            secretBroker = broker,
            toolProxy = proxy,
            port = 0,
        )

        val client = OkHttpClient()
        try {
            // Unauthorized secret request -> 401
            client.newCall(
                Request.Builder()
                    .url("${gateway.baseUrl}/v1/secret/get")
                    .header("Authorization", "Bearer wrong")
                    .post("""{"service":"s","account":"a"}""".toRequestBody(jsonMedia))
                    .build(),
            ).execute().use { resp ->
                assertEquals(401, resp.code)
            }

            // Authorized put + get
            client.newCall(
                Request.Builder()
                    .url("${gateway.baseUrl}/v1/secret/put")
                    .header("Authorization", "Bearer $secretToken")
                    .post("""{"service":"kiki.test","account":"main","value":"v-secret"}""".toRequestBody(jsonMedia))
                    .build(),
            ).execute().use { resp ->
                assertEquals(204, resp.code)
            }

            client.newCall(
                Request.Builder()
                    .url("${gateway.baseUrl}/v1/secret/get")
                    .header("Authorization", "Bearer $secretToken")
                    .post("""{"service":"kiki.test","account":"main"}""".toRequestBody(jsonMedia))
                    .build(),
            ).execute().use { resp ->
                assertEquals(200, resp.code)
                val obj = json.parseToJsonElement(resp.body!!.string()).jsonObject
                assertEquals("v-secret", obj["value"]?.jsonPrimitive?.contentOrNull)
            }

            // MCP call with mcpToken
            client.newCall(
                Request.Builder()
                    .url(gateway.mcpUrl)
                    .header("Authorization", "Bearer $mcpToken")
                    .post("""{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"phone_list_apps","arguments":{}}}""".toRequestBody(jsonMedia))
                    .build(),
            ).execute().use { resp ->
                assertEquals(200, resp.code)
                val obj = json.parseToJsonElement(resp.body!!.string()).jsonObject
                val isError = obj["result"]!!.jsonObject["isError"]!!.jsonPrimitive.booleanOrNull
                assertEquals(false, isError)
            }
        } finally {
            gateway.close()
            dir.deleteRecursively()
        }
    }

    @Test
    fun controlProtocol_and_documentStartScript_contract() {
        val ready = ControlProtocol.parseStdoutLine(
            """@@kiki {"type":"ready","port":47213,"pid":9912,"version":"0.2.0","guiPath":"/"}""",
        ) as? KernelOutboundFrame.Ready
        assertNotNull(ready)
        assertEquals(47213, ready.port)
        assertEquals(9912, ready.pid)
        assertEquals("0.2.0", ready.version)

        val turns = ControlProtocol.parseStdoutLine(
            """@@kiki {"type":"turns","active":2,"executing":true,"pendingInteraction":false}""",
        ) as? KernelOutboundFrame.Turns
        assertNotNull(turns)
        assertEquals(2, turns.active)
        assertTrue(turns.executing)

        assertNull(ControlProtocol.parseStdoutLine("ordinary console log without prefix"))

        val script = KikiWebActivity.buildDocumentStartScript("http://127.0.0.1:47213", "tok_abc")
        assertTrue(script.contains("__kikiShellStagedCredential"))
        assertTrue(script.contains("http://127.0.0.1:47213"))
        assertTrue(script.contains("tok_abc"))
    }
}
