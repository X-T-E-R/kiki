package dev.kiki.android.host

import android.content.Intent
import dev.kiki.android.host.gateway.KikiToolProxy
import dev.kiki.android.host.gateway.RegistryMcpBackendAdapter
import dev.kiki.android.host.screen.PillOverlayController
import dev.kiki.android.host.screen.ScreenArbiter
import dev.kiki.android.host.screen.ScreenToolRole
import dev.kiki.android.host.share.IncomingSharePayload
import dev.kiki.android.host.share.IncomingShareStream
import dev.kiki.android.host.share.ShareIntakeStore
import dev.kiki.android.host.tools.BatterySnapshot
import dev.kiki.android.host.tools.ClipboardSnapshot
import dev.kiki.android.host.tools.CompositeToolRegistry
import dev.kiki.android.host.tools.DeviceInfoSnapshot
import dev.kiki.android.host.tools.DeviceTool
import dev.kiki.android.host.tools.DeviceToolProvider
import dev.kiki.android.host.tools.DisplayLockSnapshot
import dev.kiki.android.host.tools.NetworkSnapshot
import dev.kiki.android.host.tools.OpenUriOutcome
import dev.kiki.android.host.tools.StorageSnapshot
import dev.kiki.android.host.tools.SystemPlatformOps
import dev.kiki.android.host.tools.SystemToolProvider
import dev.kiki.android.host.tools.ToolCallContext
import dev.kiki.android.host.tools.ToolGate
import dev.kiki.android.host.tools.ToolResults
import dev.kiki.android.host.ui.AndroidBridgeHandler
import dev.kiki.android.host.ui.KikiWebActivity
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DeviceToolProviderAndShareTest {

    private val json = Json { ignoreUnknownKeys = true }

    private class NoopPill : PillOverlayController {
        override var isShowing: Boolean = false
        override fun showOrUpdate(statusText: String, paused: Boolean) { isShowing = true }
        override fun setGesturePassThrough(passThrough: Boolean) = Unit
        override suspend fun setHiddenForScreenshot(hidden: Boolean) = Unit
        override fun hide() { isShowing = false }
    }

    private class FakeSystemOps(
        override val workspaceDir: File,
        override val shareIntakeStore: ShareIntakeStore,
        override val selfPackage: String = "dev.kiki.app",
    ) : SystemPlatformOps {
        var clipText: String? = "initial-clip"
        var lastOpenedAction: String? = null
        var lastOpenedUri: String? = null
        var lastOpenedPackage: String? = null
        var lastSharedFiles: List<File> = emptyList()
        var lastSharedText: String? = null
        var wakeCalls: Int = 0

        override fun readDeviceInfo(): DeviceInfoSnapshot = DeviceInfoSnapshot(
            manufacturer = "Google",
            model = "Pixel 9",
            sdkInt = 35,
            release = "15",
            abi = "arm64-v8a",
            locale = "zh-CN",
            timezone = "Asia/Shanghai",
            battery = BatterySnapshot(
                levelPercent = 82,
                isCharging = true,
                status = "charging",
                plugged = "usb",
                temperatureCelsius = 31.4,
            ),
            network = NetworkSnapshot(
                connected = true,
                transport = "wifi",
                metered = false,
                validated = true,
            ),
            screen = DisplayLockSnapshot(
                screenInteractive = true,
                keyguardLocked = false,
                keyguardSecure = true,
            ),
            storage = StorageSnapshot(
                availableBytes = 12L * 1024L * 1024L * 1024L,
                totalBytes = 64L * 1024L * 1024L * 1024L,
            ),
            foregroundPackage = "dev.kiki.app",
            accessibilityEnabled = false,
        )

        override suspend fun readClipboard(): ClipboardSnapshot =
            ClipboardSnapshot(
                hasContent = clipText != null,
                text = clipText,
                mimeTypes = if (clipText != null) listOf("text/plain") else emptyList(),
            )

        override suspend fun writeClipboard(text: String, label: String): Boolean {
            clipText = text
            return true
        }

        override fun openUri(action: String, uriString: String, packageName: String?): OpenUriOutcome {
            lastOpenedAction = action
            lastOpenedUri = uriString
            lastOpenedPackage = packageName
            return OpenUriOutcome(launched = true, resolvedPackage = packageName ?: "com.android.chrome")
        }

        override fun shareChooser(
            text: String?,
            subject: String?,
            title: String?,
            files: List<File>,
            mimeType: String,
        ): OpenUriOutcome {
            lastSharedText = text
            lastSharedFiles = files
            return OpenUriOutcome(launched = true)
        }

        override fun wakeScreen(durationMs: Long): DisplayLockSnapshot {
            wakeCalls++
            return DisplayLockSnapshot(screenInteractive = true, keyguardLocked = true, keyguardSecure = true)
        }
    }

    @Test
    fun compositeToolRegistry_merges_providers_first_wins_and_isolates_failures() = runTest {
        val primary = object : DeviceToolProvider {
            override val id = "primary"
            override fun tools() = listOf(
                DeviceTool(HostMcpToolDescriptor("shared_tool", "Primary version", """{"type":"object"}"""), ScreenToolRole.NONE),
                DeviceTool(HostMcpToolDescriptor("boom_tool", "Throws", """{"type":"object"}"""), ScreenToolRole.ACT),
            )
            override suspend fun call(name: String, argumentsJson: String, context: ToolCallContext): HostMcpToolCallResult {
                if (name == "boom_tool") throw IllegalStateException("simulated crash")
                return ToolResults.ok { put("winner", "primary") }
            }
        }
        val secondary = object : DeviceToolProvider {
            override val id = "secondary"
            override fun tools() = listOf(
                DeviceTool(HostMcpToolDescriptor("shared_tool", "Shadowed version", """{"type":"object"}"""), ScreenToolRole.READ),
                DeviceTool(HostMcpToolDescriptor("extra_tool", "Secondary tool", """{"type":"object"}"""), ScreenToolRole.READ),
            )
            override suspend fun call(name: String, argumentsJson: String, context: ToolCallContext): HostMcpToolCallResult =
                ToolResults.ok { put("winner", "secondary") }
        }

        val registry = CompositeToolRegistry(listOf(primary, secondary))
        assertEquals(listOf("shared_tool", "boom_tool", "extra_tool"), registry.tools().map { it.name })
        assertEquals(ScreenToolRole.NONE, registry.classify("shared_tool", "{}"))
        assertEquals(ScreenToolRole.READ, registry.classify("extra_tool", "{}"))

        val sharedRes = registry.call("shared_tool", "{}", ToolCallContext(attended = true))
        assertFalse(sharedRes.isError)
        assertEquals("primary", sharedRes.content["winner"]?.jsonPrimitive?.contentOrNull)

        val boomRes = registry.call("boom_tool", "{}", ToolCallContext(attended = true))
        assertTrue(boomRes.isError)
        assertEquals("tool_failed", boomRes.content["error"]?.jsonPrimitive?.contentOrNull)

        val unknownRes = registry.call("missing_tool", "{}", ToolCallContext(attended = true))
        assertTrue(unknownRes.isError)
        assertEquals("unknown_tool", unknownRes.content["error"]?.jsonPrimitive?.contentOrNull)
    }

    @Test
    fun systemToolProvider_exposes_valid_schemas_and_enforces_security_boundaries() = runTest {
        val dir = Files.createTempDirectory("kiki-sys-tools").toFile()
        try {
            val wsDir = File(dir, "workspace").apply { mkdirs() }
            val inboxDir = File(wsDir, "shared-inbox").apply { mkdirs() }
            val store = ShareIntakeStore(inboxDir, "dev.kiki.app")
            val ops = FakeSystemOps(wsDir, store)
            val provider = SystemToolProvider(ops)

            // Every tool descriptor must carry valid strict JSON schema
            for (tool in provider.tools()) {
                val parsed = json.parseToJsonElement(tool.descriptor.inputSchemaJson).jsonObject
                assertEquals("object", parsed["type"]?.jsonPrimitive?.contentOrNull)
                assertEquals(false, parsed["additionalProperties"]?.jsonPrimitive?.booleanOrNull)
            }

            // 1. device_info
            val infoRes = provider.call("device_info", "{}", ToolCallContext(attended = false))
            assertFalse(infoRes.isError)
            assertEquals(82, infoRes.content["battery"]!!.jsonObject["levelPercent"]!!.jsonPrimitive.intOrNull)
            assertEquals("wifi", infoRes.content["network"]!!.jsonObject["transport"]!!.jsonPrimitive.contentOrNull)
            assertEquals(true, infoRes.content["screen"]!!.jsonObject["interactive"]!!.jsonPrimitive.booleanOrNull)

            // 2. clipboard_read requires foreground attendance; clipboard_write works and updates state
            val bgClip = provider.call("clipboard_read", "{}", ToolCallContext(attended = false))
            assertTrue(bgClip.isError)
            assertEquals("unavailable_in_background", bgClip.content["error"]?.jsonPrimitive?.contentOrNull)

            val writeClip = provider.call("clipboard_write", """{"text":"hello kiki"}""", ToolCallContext(attended = false))
            assertFalse(writeClip.isError)
            val fgClip = provider.call("clipboard_read", "{}", ToolCallContext(attended = true))
            assertFalse(fgClip.isError)
            assertEquals("hello kiki", fgClip.content["text"]?.jsonPrimitive?.contentOrNull)

            // 3. open_uri: tel: uses ACTION_DIAL (never ACTION_CALL); intent:/file:/javascript:/content: blocked
            val telRes = provider.call("open_uri", """{"uri":"tel:+8613800138000"}""", ToolCallContext(attended = true))
            assertFalse(telRes.isError)
            assertEquals(Intent.ACTION_DIAL, ops.lastOpenedAction)

            for (badUri in listOf("intent://scan/#Intent;end", "file:///data/data/dev.kiki.app/secrets", "javascript:alert(1)", "content://dev.kiki.app.fileprovider/x")) {
                val blocked = provider.call("open_uri", """{"uri":"$badUri"}""", ToolCallContext(attended = true))
                assertTrue(blocked.isError, "Expected $badUri to be blocked")
                assertEquals("blocked_scheme", blocked.content["error"]?.jsonPrimitive?.contentOrNull)
            }

            // 4. share_content: workspace file succeeds; path traversal outside workspace rejected
            val reportFile = File(wsDir, "notes/summary.md").apply {
                parentFile?.mkdirs()
                writeText("# Summary\nReady", StandardCharsets.UTF_8)
            }
            val shareOk = provider.call(
                "share_content",
                """{"text":"Here is the summary","files":["notes/summary.md"]}""",
                ToolCallContext(attended = true),
            )
            assertFalse(shareOk.isError)
            assertEquals(1, ops.lastSharedFiles.size)
            assertEquals(reportFile.canonicalFile, ops.lastSharedFiles.single())

            val outsideFile = File(dir, "secret.bin").apply { writeText("top-secret") }
            val escapeAttempt = provider.call(
                "share_content",
                """{"files":["../secret.bin"]}""",
                ToolCallContext(attended = true),
            )
            assertTrue(escapeAttempt.isError)
            assertEquals("path_outside_workspace", escapeAttempt.content["error"]?.jsonPrimitive?.contentOrNull)
            assertTrue(outsideFile.exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun registryMcpBackendAdapter_and_proxy_honor_tool_gates_dynamically() = runTest {
        val dir = Files.createTempDirectory("kiki-gate-test").toFile()
        try {
            val wsDir = File(dir, "workspace").apply { mkdirs() }
            val store = ShareIntakeStore(File(wsDir, "inbox"), "dev.kiki.app")
            val settings = KikiHostSettings(InMemoryHostSettingsStore())
            val registry = CompositeToolRegistry(listOf(SystemToolProvider(FakeSystemOps(wsDir, store))))
            val backend = RegistryMcpBackendAdapter(
                registry = registry,
                gateCheck = { gate ->
                    when (gate) {
                        ToolGate.NONE -> true
                        ToolGate.WAKE_SCREEN -> settings.allowWakeUnlock
                        ToolGate.CLIPBOARD_READ -> settings.allowClipboardRead
                        ToolGate.CLIPBOARD_WRITE -> settings.allowClipboardWrite
                    }
                },
                attendedCheck = { true },
            )
            val arbiter = ScreenArbiter(
                selfPackage = "dev.kiki.app",
                foregroundPackageProvider = { "dev.kiki.app" },
                yieldSelfToBackground = { true },
                pill = NoopPill(),
                roleClassifier = registry::classify,
            )
            val proxy = KikiToolProxy(backend, arbiter, "0.1.0")

            // Default: clipboard_read & clipboard_write enabled, device_wake disabled
            val initialNames = proxy.visibleTools().map { it.name }
            assertTrue("device_info" in initialNames)
            assertTrue("clipboard_read" in initialNames)
            assertFalse("device_wake" in initialNames)

            // Disable clipboard_read -> hidden from tools/list and rejected with -32601 on tools/call
            settings.allowClipboardRead = false
            assertFalse("clipboard_read" in proxy.visibleTools().map { it.name })
            val deniedCall = proxy.handleJsonRpc(
                """{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"clipboard_read","arguments":{}}}""",
            )!!.jsonObject
            assertEquals(-32601, deniedCall["error"]!!.jsonObject["code"]!!.jsonPrimitive.intOrNull)

            // Enable wake -> device_wake appears and succeeds
            settings.allowWakeUnlock = true
            assertTrue("device_wake" in proxy.visibleTools().map { it.name })
            val wakeCall = proxy.handleJsonRpc(
                """{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"device_wake","arguments":{}}}""",
            )!!.jsonObject
            assertEquals(false, wakeCall["result"]!!.jsonObject["isError"]!!.jsonPrimitive.booleanOrNull)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun shareIntakeStore_stages_external_streams_blocks_self_and_file_uris_and_wires_bridge() {
        val dir = Files.createTempDirectory("kiki-share-intake").toFile()
        try {
            val inboxDir = File(dir, "shared-inbox")
            val store = ShareIntakeStore(inboxDir, selfPackage = "dev.kiki.app", clock = { 1_700_000_000_000L })

            val batch = store.stageIncoming(
                IncomingSharePayload(
                    action = Intent.ACTION_SEND_MULTIPLE,
                    mimeType = "*/*",
                    subject = "Trip Receipt",
                    text = "https://example.com/receipt",
                    streams = listOf(
                        IncomingShareStream(
                            uriString = "content://com.android.providers.media.documents/document/image%3A99",
                            scheme = "content",
                            authority = "com.android.providers.media.documents",
                            displayName = "../../invoice 2026.pdf",
                            mimeType = "application/pdf",
                            open = { ByteArrayInputStream("PDF-DATA".toByteArray(StandardCharsets.UTF_8)) },
                        ),
                        // Self-package provider must be rejected to prevent confused-deputy exfiltration
                        IncomingShareStream(
                            uriString = "content://dev.kiki.app.fileprovider/kiki_workspace/secret.txt",
                            scheme = "content",
                            authority = "dev.kiki.app.fileprovider",
                            displayName = "secret.txt",
                            mimeType = "text/plain",
                            open = { ByteArrayInputStream("NOPE".toByteArray()) },
                        ),
                        // file:// URI must be rejected
                        IncomingShareStream(
                            uriString = "file:///data/data/dev.kiki.app/files/kiki/secure/secrets.bin",
                            scheme = "file",
                            authority = null,
                            displayName = "secrets.bin",
                            mimeType = "application/octet-stream",
                            open = { ByteArrayInputStream("NOPE".toByteArray()) },
                        ),
                    ),
                ),
            )
            assertNotNull(batch)
            assertEquals(2, batch.items.size)
            val textItem = batch.items[0]
            val fileItem = batch.items[1]
            assertEquals("Trip Receipt\nhttps://example.com/receipt", textItem.text)
            assertEquals("invoice_2026.pdf", fileItem.name)
            assertNotNull(fileItem.path)
            assertEquals("PDF-DATA", File(fileItem.path!!).readText(StandardCharsets.UTF_8))

            // Reload from fresh store instance to verify persisted JSON index
            val reloaded = ShareIntakeStore(inboxDir, selfPackage = "dev.kiki.app")
            assertEquals(1, reloaded.listBatches().size)

            // Bridge takeShareIntake returns matching items array
            val bridgeOut = AndroidBridgeHandler.dispatchMethod(
                method = "takeShareIntake",
                params = buildJsonObject { put("id", batch.id) },
                capabilitiesProvider = { buildJsonObject {} },
                openPermission = {},
                openNativePhoneSettings = {},
                setAppearance = {},
                setAllowWakeUnlock = {},
                resumeScreenAutomation = {},
                readClipboard = { null },
                writeClipboard = {},
                shareText = {},
                takeShareIntake = reloaded::takeBatchItems,
            ).jsonArray
            assertEquals(2, bridgeOut.size)
            assertEquals("invoice_2026.pdf", bridgeOut[1].jsonObject["name"]?.jsonPrimitive?.contentOrNull)

            // Composer draft formatting includes both text and staged file path, and injection script targets [data-composer]
            val draft = ShareIntakeStore.formatComposerDraft(batch)
            assertTrue(draft.contains("https://example.com/receipt"))
            assertTrue(draft.contains(fileItem.path!!))
            val script = KikiWebActivity.buildShareDraftInjectionScript(draft)
            assertTrue(script.contains("[data-composer-input]"))
            assertTrue(script.contains("/new"))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun hostSettings_validates_proxy_urls() {
        val settings = KikiHostSettings(InMemoryHostSettingsStore())
        assertNull(settings.proxyUrl)

        settings.proxyUrl = "  http://127.0.0.1:7890  "
        assertEquals("http://127.0.0.1:7890", settings.proxyUrl)

        settings.proxyUrl = "socks5://192.168.1.2:1080"
        assertEquals("socks5://192.168.1.2:1080", settings.proxyUrl)

        settings.proxyUrl = "   "
        assertNull(settings.proxyUrl)

        assertFailsWith<IllegalArgumentException> {
            settings.proxyUrl = "ftp://example.com:21"
        }
        assertFailsWith<IllegalArgumentException> {
            settings.proxyUrl = "http://127.0.0.1"
        }
    }
}
