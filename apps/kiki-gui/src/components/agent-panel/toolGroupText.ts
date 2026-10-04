import type { I18nKey } from '@kiki/session-core/i18n';
import { toolCategoryLabel } from './ToolChipList';
import type { ToolGroup, ToolGroupCounts } from './toolGroups';

type Translate = (key: I18nKey, params?: Record<string, string | number>) => string;

/**
 * Display text for one tool group. Titles keep the server's own words: a
 * built-in category is localized from its existing label, an extension is
 * `MCP · <owner>` / `插件 · <owner>` with an explicit fallback when the
 * provider was never reported, and an unknown source keeps its raw value.
 * Counts stay machine-derived: `x/y`, five states, no invented totals. The
 * chip and the group panel's meta line both show the bare ratio; the word that
 * names the state reaches a reader through the accessible name, the cluster
 * preview and the group panel's per-row state, where it is not repeated on
 * every chip.
 */
export function toolGroupTitle(t: Translate, group: ToolGroup): string {
  switch (group.kind) {
    case 'builtin':
      return toolCategoryLabel(t, group.token);
    case 'user':
      return t('inspector.cap.userTools');
    case 'source':
      return group.token;
    case 'mcp':
    case 'plugin': {
      const kind = t(group.kind === 'mcp' ? 'inspector.cap.mcp' : 'inspector.cap.plugin');
      return `${kind} · ${group.ownerReported ? group.token : t('inspector.cap.ownerUnreported')}`;
    }
  }
}

/** The origin word on the group panel's meta line; extensions already say it in the title. */
export function toolGroupOrigin(t: Translate, group: ToolGroup): string | undefined {
  switch (group.kind) {
    case 'builtin':
      return t('inspector.cap.builtin');
    case 'user':
      return t('inspector.cap.userTools');
    case 'source':
      return group.token;
    case 'mcp':
    case 'plugin':
      return undefined;
  }
}

/**
 * `x/y 开启`, or `?/y 开启` when the group reported no known state at all: the
 * chip's accessible name and the cluster preview's head line, both of which
 * have the room to say what the numbers are.
 */
export function toolGroupCountLine(t: Translate, counts: ToolGroupCounts): string {
  return counts.total > 0 && counts.unknown === counts.total
    ? t('inspector.cap.groupCountUnknown', { total: counts.total })
    : t('inspector.cap.groupCount', { on: counts.on, total: counts.total });
}

/** `x/y`, or `?/y` when nothing in the group has a known state: the chip's own text and the group panel's meta line. */
export function toolGroupCountRatio(t: Translate, counts: ToolGroupCounts): string {
  return counts.total > 0 && counts.unknown === counts.total
    ? t('inspector.cap.groupCountRatioUnknown', { total: counts.total })
    : t('inspector.cap.groupCountRatio', { on: counts.on, total: counts.total });
}

/** The state notes after the count line: pending, then disconnected, then unconfirmed. */
export function toolGroupNotes(t: Translate, counts: ToolGroupCounts): string[] {
  const notes: string[] = [];
  if (counts.approvalRequired > 0) notes.push(t('inspector.cap.groupPending', { count: counts.approvalRequired }));
  if (counts.disconnected > 0) notes.push(t('inspector.cap.groupDisconnectedNote', { count: counts.disconnected }));
  if (counts.unknown > 0 && counts.unknown < counts.total) notes.push(t('inspector.cap.groupUnknownNote', { count: counts.unknown }));
  return notes;
}
