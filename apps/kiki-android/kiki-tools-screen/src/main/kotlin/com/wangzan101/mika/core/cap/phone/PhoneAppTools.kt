// Adapted from Mika (Copyright (c) wangzan101 and Mika contributors), Apache-2.0.
package com.wangzan101.mika.core.cap.phone

import com.wangzan101.mika.core.tool.LinkPolicy
import com.wangzan101.mika.core.uistate.*
import dev.kiki.android.host.HostMcpToolCallResult
import dev.kiki.android.host.tools.ToolResults
import kotlinx.serialization.json.*
import java.time.*
import java.time.format.DateTimeFormatter

internal class PhoneAppTools(
    private val port: ScreenPort,
    private val selfPackage: String,
    private val mutate: suspend (suspend () -> ActionResult) -> HostMcpToolCallResult,
) {
    val handlers: Map<String, suspend (PhoneArgs) -> HostMcpToolCallResult> = mapOf(
        "list_apps" to { listApps() },
        "launch_app" to ::launch,
        "app_after_task" to { a -> afterTask(a) },
        "share_text" to { a ->
            val pkg = a.pkg()
            mutate { port.shareText(pkg, a.text("text")!!) }
        },
        "open_link" to ::openLink,
        "set_alarm" to ::alarm,
        "set_timer" to { a ->
            system(SystemAction.SetTimer(a.int("seconds")!!, a.text("label"))) { put("requested", buildJsonObject { put("seconds", a.int("seconds")!!) }) }
        },
        "show_alarms" to { system(SystemAction.ShowAlarms) },
        "add_calendar_event" to { a ->
            val event = calendarEvent(a, utcAllDay = false)
            system(event) { put("requested", buildJsonObject {
                put("title", event.title); put("start", local(event.beginMs)); event.endMs?.let { put("end", local(it)) }
                if (event.allDay) put("allDay", true)
            }) }
        },
        "calendar_bulk_insert" to ::bulkCalendar,
    )

    private suspend fun listApps(): HostMcpToolCallResult {
        val apps = port.listApps()
        val copies = port.appCopies().groupBy { it.packageName }
        val access = port.appAccess.current()
        return ToolResults.ok {
            put("apps", JsonArray(apps.flatMap { (pkg, label) ->
                listOf(buildJsonObject {
                    put("package", pkg); put("label", label)
                    if (pkg in access.blocked) put("blocked", true)
                    if (pkg in access.shareAllowed) put("screenShareAllowed", true)
                }) + copies[pkg].orEmpty().map { c -> buildJsonObject { put("package", pkg); put("label", c.label(label)); put("user", c.userId) } }
            }))
        }
    }

    private suspend fun launch(a: PhoneArgs): HostMcpToolCallResult {
        val pkg = a.pkg(); val user = a.int("user"); val wait = a.int("wait")
        if (user != null && port.appCopies().none { it.packageName == pkg && it.userId == user }) return ToolResults.error("copy_not_found")
        return mutate {
            suspend fun open() = if (user == null) port.openApp(pkg, a.bool("cold")) else port.openAppCopy(pkg, user, a.bool("cold"))
            var result = open()
            if (wait != null && result is ActionResult.Failed && result.reason == APP_IN_USE_BY_OTHER_TASK) {
                result = when (port.awaitAppFree(pkg, user, wait * 1_000L)) {
                    AppWait.Free -> open()
                    AppWait.TimedOut -> ActionResult.Failed("app_wait_timed_out")
                    AppWait.WouldDeadlock -> ActionResult.Failed("app_wait_would_deadlock")
                    AppWait.Unsupported -> result
                }
            }
            result
        }
    }

    private fun afterTask(a: PhoneArgs): HostMcpToolCallResult {
        val pkg = a.pkg(); val keep = a.text("action") == "keep"
        val marks = port.afterTask ?: return ToolResults.error("after_task_unavailable")
        val previous = marks.mark(pkg, a.int("user"), keep, a.text("reason")!!)
        return ToolResults.ok {
            put("package", pkg); a.int("user")?.let { put("user", it) }; put("action", if (keep) "keep" else "close")
            previous?.takeIf { it.keep != keep }?.let { put("replaces", if (it.keep) "keep" else "close") }
        }
    }

    private suspend fun openLink(a: PhoneArgs): HostMcpToolCallResult {
        val uri = a.text("uri")?.trim(); val action = a.text("action")?.trim(); val pkg = a.text("package")?.trim()
        LinkPolicy.check(action, uri, pkg)?.let { return ToolResults.error("invalid_link", it) }
        if (pkg == selfPackage || uri?.contains(selfPackage) == true) return ToolResults.error("self_target_blocked")
        if (action == null) return ToolResults.error("link_authorization_unavailable", "The Android host has no task reference-note authorization for URI links. Use open_uri for a user-directed link.")
        return mutate { port.openLink(action, uri, pkg) }
    }

    private suspend fun alarm(a: PhoneArgs): HostMcpToolCallResult {
        val hour = a.int("hour")!!; val minute = a.int("minute")!!
        val days = a.array("days")?.map { raw ->
            WEEKDAYS.indexOf(raw.jsonPrimitive.content.trim().uppercase().take(3)).takeIf { it >= 0 }?.plus(1)
                ?: throw PhoneArgError("days", "must be MON, TUE, WED, THU, FRI, SAT or SUN")
        }?.distinct()?.sorted().orEmpty()
        var outcome: SystemActionResult? = null
        val result = mutate {
            port.systemAction(SystemAction.SetAlarm(hour, minute, a.text("label"), days, a.optionalBool("vibrate"))).also { outcome = it }.result
        }
        if (result.isError) return result
        val res = outcome!!
        val check = AlarmCheck.of(hour, minute, res)
        return merge(result, buildJsonObject {
            put("requested", buildJsonObject {
                put("time", "%02d:%02d".format(hour, minute)); a.text("label")?.let { put("label", it) }
                if (days.isNotEmpty()) put("days", JsonArray(days.map { JsonPrimitive(WEEKDAYS[it - 1]) }))
            })
            put("check", check.wire); res.nextAlarmAfter?.let { put("nextAlarm", local(it)) }
            res.handledBy?.let { put("handledBy", it) }; if (res.showing) put("screenOpened", true)
        })
    }

    private suspend fun system(action: SystemAction, extra: JsonObjectBuilder.() -> Unit = {}): HostMcpToolCallResult {
        var outcome: SystemActionResult? = null
        val result = mutate { port.systemAction(action).also { outcome = it }.result }
        if (result.isError) return result
        return merge(result, buildJsonObject {
            outcome!!.handledBy?.let { put("handledBy", it) }
            if (outcome!!.showing) put("screenOpened", true)
            extra()
        })
    }

    private suspend fun bulkCalendar(a: PhoneArgs): HostMcpToolCallResult {
        val raw = a.array("events")!!
        val events = raw.mapIndexed { i, item ->
            try { calendarEvent(PhoneArgs(item.jsonObject), utcAllDay = true) }
            catch (e: PhoneArgError) { throw PhoneArgError("events[$i]", e.message!!) }
        }
        var outcome: SystemActionResult? = null
        val result = mutate {
            port.bulkCalendarInsert(events).also { outcome = it }.let { res ->
                if (res.result is ActionResult.Ok && (res.eventUris.size != events.size || res.eventUris.any { eventId(it) == null }))
                    ActionResult.Failed("calendar_write_unconfirmed") else res.result
            }
        }
        if (result.isError) return result
        return merge(result, buildJsonObject {
            put("inserted", events.size)
            put("eventIds", JsonArray(outcome!!.eventUris.map { JsonPrimitive(eventId(it)!!) }))
        })
    }

    private fun PhoneArgs.pkg(): String {
        val pkg = text("package")!!
        if (!LinkPolicy.PACKAGE.matches(pkg)) throw PhoneArgError("package", "must be an Android package name")
        if (pkg == selfPackage) throw PhoneArgError("package", "cannot target Kiki itself")
        port.appAccess.current().denial(pkg)?.let { throw it }
        return pkg
    }

    private fun PhoneArgs.optionalBool(key: String): Boolean? = text(key)?.let { bool(key) }
    private fun eventId(uri: String): String? = uri.takeIf { it.startsWith("content://") }?.substringAfterLast('/')
        ?.takeIf { it.toLongOrNull()?.let { id -> id > 0 } == true }

    private fun calendarEvent(a: PhoneArgs, utcAllDay: Boolean): SystemAction.AddCalendarEvent {
        val allDay = a.bool("allDay"); val zone = ZoneId.systemDefault()
        val begin = CalendarTime.parse(a.text("start")!!, allDay, zone, utcAllDay)
            ?: throw PhoneArgError("start", "must be an ISO date-time, or a date with allDay=true")
        val end = a.text("end")?.let { CalendarTime.parse(it, allDay, zone, utcAllDay) ?: throw PhoneArgError("end", "must use the same format as start") }
        if (end != null && end < begin) throw PhoneArgError("end", "must not be before start")
        val title = a.text("title")!!
        if (title.length !in 1..200) throw PhoneArgError("title", "must have 1-200 characters")
        return SystemAction.AddCalendarEvent(title, begin, end ?: CalendarTime.defaultEnd(begin, allDay), allDay, a.text("location"), a.text("description"))
    }

    private fun local(ms: Long): String = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))
    private val WEEKDAYS = listOf("SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT")
}

internal object AlarmCheck {
    enum class Status(val wire: String) { VERIFIED("verified"), EARLIER_FIRST("earlier_alarm_first"), NOT_SEEN("not_seen"), UNKNOWN("unknown") }
    fun of(hour: Int, minute: Int, res: SystemActionResult, zone: ZoneId = ZoneId.systemDefault(), now: Long = System.currentTimeMillis()): Status {
        if (!res.alarmReadable) return Status.UNKNOWN
        val next = res.nextAlarmAfter ?: return Status.NOT_SEEN
        val at = Instant.ofEpochMilli(next).atZone(zone)
        if (at.hour == hour && at.minute == minute) return Status.VERIFIED
        val current = Instant.ofEpochMilli(now).atZone(zone)
        var mine = current.withHour(hour).withMinute(minute).withSecond(0).withNano(0)
        if (!mine.isAfter(current)) mine = mine.plusDays(1)
        return if (next < mine.toInstant().toEpochMilli()) Status.EARLIER_FIRST else Status.NOT_SEEN
    }
}

internal object CalendarTime {
    fun parse(s: String, allDay: Boolean, zone: ZoneId, utcAllDay: Boolean = false): Long? {
        val t = s.trim()
        runCatching { return OffsetDateTime.parse(t).toInstant().toEpochMilli() }
        runCatching { return LocalDateTime.parse(t).atZone(zone).toInstant().toEpochMilli() }
        runCatching { return LocalDateTime.parse("${t}:00").atZone(zone).toInstant().toEpochMilli() }
        if (allDay) runCatching { return LocalDate.parse(t).atStartOfDay(if (utcAllDay) ZoneOffset.UTC else zone).toInstant().toEpochMilli() }
        return null
    }
    fun defaultEnd(begin: Long, allDay: Boolean) = begin + if (allDay) 24 * 3_600_000L else 3_600_000L
}
