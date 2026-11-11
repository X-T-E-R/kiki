/*
 * Adapted from Mika (https://github.com/wangzan101/Mika), licensed under Apache-2.0.
 * Modified package namespace for Kiki Android screen module.
 */
package dev.kiki.android.tools.screen.a11y

import android.content.Intent
import android.net.Uri
import android.provider.AlarmClock
import android.provider.CalendarContract
import com.wangzan101.mika.core.uistate.SystemAction

internal object SystemIntents {
    const val EVENTS_TYPE = "vnd.android.cursor.dir/event"
    const val EVENTS_URI = "content://${CalendarContract.AUTHORITY}/events"

    data class Spec(
        val action: String,
        val data: String? = null,
        val type: String? = null,
        val extras: Map<String, Any> = emptyMap(),
    )

    fun spec(a: SystemAction): Spec = when (a) {
        is SystemAction.SetAlarm -> Spec(
            AlarmClock.ACTION_SET_ALARM,
            extras = buildMap {
                put(AlarmClock.EXTRA_HOUR, a.hour)
                put(AlarmClock.EXTRA_MINUTES, a.minute)
                put(AlarmClock.EXTRA_SKIP_UI, true)
                a.label?.let { put(AlarmClock.EXTRA_MESSAGE, it) }
                if (a.days.isNotEmpty()) put(AlarmClock.EXTRA_DAYS, ArrayList(a.days))
                a.vibrate?.let { put(AlarmClock.EXTRA_VIBRATE, it) }
            },
        )
        is SystemAction.SetTimer -> Spec(
            AlarmClock.ACTION_SET_TIMER,
            extras = buildMap {
                put(AlarmClock.EXTRA_LENGTH, a.seconds)
                put(AlarmClock.EXTRA_SKIP_UI, true)
                a.label?.let { put(AlarmClock.EXTRA_MESSAGE, it) }
            },
        )
        SystemAction.ShowAlarms -> Spec(AlarmClock.ACTION_SHOW_ALARMS)
        is SystemAction.AddCalendarEvent -> Spec(
            Intent.ACTION_INSERT,
            EVENTS_URI,
            EVENTS_TYPE,
            buildMap {
                put(CalendarContract.Events.TITLE, a.title)
                put(CalendarContract.EXTRA_EVENT_BEGIN_TIME, a.beginMs)
                a.endMs?.let { put(CalendarContract.EXTRA_EVENT_END_TIME, it) }
                if (a.allDay) put(CalendarContract.EXTRA_EVENT_ALL_DAY, true)
                a.location?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
                a.description?.let { put(CalendarContract.Events.DESCRIPTION, it) }
            },
        )
    }

    fun toIntent(s: Spec): Intent {
        val i = Intent(s.action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        when {
            s.data != null && s.type != null -> i.setDataAndType(Uri.parse(s.data), s.type)
            s.data != null -> i.data = Uri.parse(s.data)
            s.type != null -> i.type = s.type
        }
        for ((k, v) in s.extras) {
            when (v) {
                is Int -> i.putExtra(k, v)
                is Long -> i.putExtra(k, v)
                is Boolean -> i.putExtra(k, v)
                is String -> i.putExtra(k, v)
                is ArrayList<*> -> i.putIntegerArrayListExtra(k, ArrayList(v.filterIsInstance<Int>()))
                else -> error("unsupported extra $k")
            }
        }
        return i
    }
}
