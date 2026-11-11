/*
 * Adapted from Mika (https://github.com/wangzan101/Mika), licensed under Apache-2.0.
 * Modified package namespace for Kiki Android screen module.
 */
package dev.kiki.android.tools.screen.a11y

import android.view.accessibility.AccessibilityNodeInfo
import com.wangzan101.mika.core.cap.phone.PHONE_SNAPSHOT_PREFIX
import com.wangzan101.mika.core.uistate.ElementLocator
import com.wangzan101.mika.core.uistate.UiElement
import java.util.UUID

internal fun snapshotId(): String = PHONE_SNAPSHOT_PREFIX + UUID.randomUUID()

internal class NodeEntry(
    val element: UiElement,
    val locator: ElementLocator,
    val node: AccessibilityNodeInfo,
)

internal class NodeSnapshot(val id: String, val entries: List<NodeEntry>) {
    val locators: List<ElementLocator> get() = entries.map { it.locator }
}

internal class NodeIds(private val keep: Int = 4) {
    sealed interface Lookup {
        class Current(val entry: NodeEntry, val snapshot: NodeSnapshot) : Lookup
        class Old(val entry: NodeEntry, val snapshot: NodeSnapshot) : Lookup
        data object Unknown : Lookup
    }

    private val history = ArrayDeque<NodeSnapshot>()

    @Synchronized
    fun put(snapshot: NodeSnapshot) {
        history.addFirst(snapshot)
        while (history.size > keep) history.removeLast()
    }

    @Synchronized
    fun clear() {
        history.clear()
    }

    @Synchronized
    fun current(): NodeSnapshot? = history.firstOrNull()

    @Synchronized
    fun lookup(ref: String, snapshotId: String): Lookup {
        val index = ref.removePrefix("@e").toIntOrNull()?.minus(1) ?: return Lookup.Unknown
        val i = history.indexOfFirst { it.id == snapshotId }
        if (i < 0) return Lookup.Unknown
        val snap = history[i]
        val entry = snap.entries.getOrNull(index) ?: return Lookup.Unknown
        return if (i == 0) Lookup.Current(entry, snap) else Lookup.Old(entry, snap)
    }
}
