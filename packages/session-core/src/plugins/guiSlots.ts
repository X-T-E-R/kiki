import type {
  PluginGuiSlotContribution,
  PluginLocalizedText,
} from '@kiki/protocol';

export type PluginComposerToolbarSlotContribution = Extract<
  PluginGuiSlotContribution,
  { slot: 'composer-toolbar' }
>;
export type PluginStatusCapsuleSlotContribution = Extract<
  PluginGuiSlotContribution,
  { slot: 'status-capsule' }
>;
export type PluginMessageActionSlotContribution = Extract<
  PluginGuiSlotContribution,
  { slot: 'message-action' }
>;
export type PluginSlashCommandSlotContribution = Extract<
  PluginGuiSlotContribution,
  { slot: 'slash-command' }
>;
export type PluginSettingsSectionSlotContribution = Extract<
  PluginGuiSlotContribution,
  { slot: 'settings-section' }
>;
export type PluginToolCardRendererSlotContribution = Extract<
  PluginGuiSlotContribution,
  { slot: 'tool-card-renderer' }
>;
export type PluginSandboxedPanelSlotContribution = Extract<
  PluginGuiSlotContribution,
  { slot: 'sidebar-panel' | 'inspector-tab' }
>;
export type PluginSidebarPanelSlotContribution = PluginSandboxedPanelSlotContribution & {
  slot: 'sidebar-panel';
};
export type PluginInspectorTabSlotContribution = PluginSandboxedPanelSlotContribution & {
  slot: 'inspector-tab';
};
export type PluginToolCardFieldSpec = PluginToolCardRendererSlotContribution['summaryFields'][number];

const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SLOT_ROOTS = new Set(['args', 'result', 'display']);

export function resolvePluginLocalizedText(
  text: PluginLocalizedText,
  locale: 'en' | 'zh' | string,
): string {
  const normalizedLocale = locale.toLowerCase().startsWith('zh')
    ? 'zh'
    : locale.toLowerCase().startsWith('en')
      ? 'en'
      : undefined;
  const localized = normalizedLocale === 'zh'
    ? text.zh
    : normalizedLocale === 'en'
      ? text.en
      : undefined;
  return localized !== undefined && localized.trim() !== '' ? localized : text.default;
}

function slotKey(slot: PluginGuiSlotContribution): string {
  return `${slot.slot}:${slot.pluginId}:${slot.id}`;
}

function deduplicatePluginGuiSlots(
  slots: readonly PluginGuiSlotContribution[],
): PluginGuiSlotContribution[] {
  const latestByKey = new Map<string, PluginGuiSlotContribution>();
  for (const slot of slots) latestByKey.set(slotKey(slot), slot);
  return [...latestByKey.values()];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface OrderedPluginGuiSlot {
  readonly order: number;
  readonly pluginId: string;
  readonly id: string;
}

function compareOrderedSlots(left: OrderedPluginGuiSlot, right: OrderedPluginGuiSlot): number {
  return left.order - right.order || compareText(left.pluginId, right.pluginId) || compareText(left.id, right.id);
}

function selectOrderedSlots<T extends PluginGuiSlotContribution & OrderedPluginGuiSlot>(
  slots: readonly PluginGuiSlotContribution[],
  isSlot: (slot: PluginGuiSlotContribution) => slot is T,
): T[] {
  return deduplicatePluginGuiSlots(slots).filter(isSlot).toSorted(compareOrderedSlots);
}

export function selectComposerToolbarSlots(
  slots: readonly PluginGuiSlotContribution[],
): PluginComposerToolbarSlotContribution[] {
  return selectOrderedSlots(
    slots,
    (slot): slot is PluginComposerToolbarSlotContribution => slot.slot === 'composer-toolbar',
  );
}

export function selectStatusCapsuleSlots(
  slots: readonly PluginGuiSlotContribution[],
): PluginStatusCapsuleSlotContribution[] {
  return selectOrderedSlots(
    slots,
    (slot): slot is PluginStatusCapsuleSlotContribution => slot.slot === 'status-capsule',
  );
}

export function selectMessageActionSlots(
  slots: readonly PluginGuiSlotContribution[],
  role: 'user' | 'assistant',
): PluginMessageActionSlotContribution[] {
  return selectOrderedSlots(
    slots,
    (slot): slot is PluginMessageActionSlotContribution =>
      slot.slot === 'message-action' && slot.appliesToRoles.includes(role),
  );
}

/** Deduplicates slash slots and sorts them by plugin id, then slot id. */
export function selectSlashCommandSlots(
  slots: readonly PluginGuiSlotContribution[],
): PluginSlashCommandSlotContribution[] {
  return deduplicatePluginGuiSlots(slots)
    .filter((slot): slot is PluginSlashCommandSlotContribution => slot.slot === 'slash-command')
    .toSorted((left, right) => compareText(left.pluginId, right.pluginId) || compareText(left.id, right.id));
}

export function selectSettingsSectionSlots(
  slots: readonly PluginGuiSlotContribution[],
): PluginSettingsSectionSlotContribution[] {
  return selectOrderedSlots(
    slots,
    (slot): slot is PluginSettingsSectionSlotContribution => slot.slot === 'settings-section',
  );
}

export function selectSidebarPanelSlots(
  slots: readonly PluginGuiSlotContribution[],
): PluginSidebarPanelSlotContribution[] {
  return selectOrderedSlots(
    slots,
    (slot): slot is PluginSidebarPanelSlotContribution => slot.slot === 'sidebar-panel',
  );
}

export function selectInspectorTabSlots(
  slots: readonly PluginGuiSlotContribution[],
): PluginInspectorTabSlotContribution[] {
  return selectOrderedSlots(
    slots,
    (slot): slot is PluginInspectorTabSlotContribution => slot.slot === 'inspector-tab',
  );
}

export function selectToolCardRendererSlots(
  slots: readonly PluginGuiSlotContribution[],
): PluginToolCardRendererSlotContribution[] {
  return deduplicatePluginGuiSlots(slots)
    .filter((slot): slot is PluginToolCardRendererSlotContribution => slot.slot === 'tool-card-renderer');
}

function sanitizeToolMatchPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function normalizedPluginToolName(pluginId: string, declaredName: string): string {
  return `plugin__${sanitizeToolMatchPart(pluginId)}__${sanitizeToolMatchPart(declaredName)}`;
}

export function normalizePluginToolMatchKeys(pluginId: string, declaredName: string): string[] {
  return [...new Set([declaredName, normalizedPluginToolName(pluginId, declaredName)])];
}

export function findToolCardRendererSlot(
  slots: readonly PluginGuiSlotContribution[],
  toolName: string,
): PluginToolCardRendererSlotContribution | undefined {
  const renderers = selectToolCardRendererSlots(slots);
  for (const renderer of renderers) {
    if (renderer.toolNames.includes(toolName)) return renderer;
  }
  for (const renderer of renderers) {
    if (renderer.toolNames.some((declaredName) =>
      normalizedPluginToolName(renderer.pluginId, declaredName) === toolName,
    )) return renderer;
  }
  return undefined;
}

function parseFieldPath(sourcePath: string): string[] | undefined {
  if (sourcePath === '') return undefined;
  const segments: string[] = [];
  let index = 0;
  let needsSegment = true;

  while (index < sourcePath.length) {
    const character = sourcePath[index];
    if (character === '.') {
      if (needsSegment) return undefined;
      needsSegment = true;
      index += 1;
      continue;
    }
    if (character === '[') {
      if (needsSegment && segments.length > 0) return undefined;
      const closeIndex = sourcePath.indexOf(']', index + 1);
      if (closeIndex === -1) return undefined;
      const segment = sourcePath.slice(index + 1, closeIndex);
      if (!/^\d+$/.test(segment)) return undefined;
      segments.push(segment);
      index = closeIndex + 1;
      needsSegment = false;
      continue;
    }
    if (!needsSegment) return undefined;
    const start = index;
    while (index < sourcePath.length && sourcePath[index] !== '.' && sourcePath[index] !== '[') {
      if (sourcePath[index] === ']') return undefined;
      index += 1;
    }
    if (start === index) return undefined;
    segments.push(sourcePath.slice(start, index));
    needsSegment = false;
  }

  return needsSegment ? undefined : segments;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataProperty(
  value: object,
  key: string,
): { readonly found: boolean; readonly value: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor
      ? { found: true, value: descriptor.value }
      : { found: descriptor !== undefined, value: undefined };
  } catch {
    return { found: false, value: undefined };
  }
}

function readFieldPath(root: unknown, segments: readonly string[]): unknown {
  let value = root;
  for (const segment of segments) {
    if (PROTOTYPE_KEYS.has(segment) || typeof value !== 'object' || value === null) return undefined;
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(segment)) return undefined;
    const property = ownDataProperty(value, segment);
    if (!property.found) return undefined;
    value = property.value;
  }
  return value;
}

export function resolvePluginToolFieldValue(
  sources: { readonly args?: unknown; readonly result?: unknown; readonly display?: unknown },
  sourcePath: string,
): unknown {
  const segments = parseFieldPath(sourcePath);
  if (segments === undefined) return undefined;

  const firstSegment = segments[0];
  if (firstSegment !== undefined && SLOT_ROOTS.has(firstSegment)) {
    const root = ownDataProperty(sources, firstSegment);
    if (root.found) return readFieldPath(root.value, segments.slice(1));
  }

  for (const rootName of ['args', 'display', 'result'] as const) {
    const root = ownDataProperty(sources, rootName);
    if (root.found && isPlainObject(root.value)) {
      const value = readFieldPath(root.value, segments);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function compactString(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stringifyValue(value: unknown, space?: number): string | undefined {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return undefined;
  }
}

function keyValueText(value: object): string | undefined {
  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return undefined;
  }
  const pairs = entries.map(([key, entryValue]) => {
    let formattedValue: string;
    if (typeof entryValue === 'string') formattedValue = compactString(entryValue);
    else if (entryValue === undefined) formattedValue = 'undefined';
    else if (entryValue === null || typeof entryValue === 'number' || typeof entryValue === 'boolean') {
      formattedValue = String(entryValue);
    } else {
      formattedValue = stringifyValue(entryValue) ?? String(entryValue);
    }
    return `${key}: ${formattedValue}`;
  });
  return pairs.join(', ');
}

export function formatPluginToolFieldValue(
  value: unknown,
  format?: PluginToolCardFieldSpec['format'],
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    return format === 'diff' || format === 'code' ? value : compactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (format === 'key-value') return keyValueText(value);
  if (format === 'code' || format === 'diff') return stringifyValue(value, 2);
  return stringifyValue(value);
}

export interface PluginPromptInsertRequest {
  readonly text: string;
  readonly submit?: boolean;
  readonly args?: string;
}

export const DRAFT_COMPOSER_TARGET = '__new_draft__';

type PluginPromptInsertListener = (request: PluginPromptInsertRequest) => boolean;
interface PluginPromptInsertSubscription {
  readonly listener: PluginPromptInsertListener;
}

const promptInsertListeners = new Map<string, Set<PluginPromptInsertSubscription>>();

function normalizeComposerTarget(targetKey: string | undefined): string {
  return targetKey ?? DRAFT_COMPOSER_TARGET;
}

export function subscribePluginPromptInserts(
  targetKey: string | undefined,
  listener: (request: PluginPromptInsertRequest) => boolean,
): () => void {
  const target = normalizeComposerTarget(targetKey);
  const subscription = { listener };
  const listeners = promptInsertListeners.get(target) ?? new Set<PluginPromptInsertSubscription>();
  listeners.add(subscription);
  promptInsertListeners.set(target, listeners);
  return () => {
    listeners.delete(subscription);
    if (listeners.size === 0) promptInsertListeners.delete(target);
  };
}

export function requestPluginPromptInsert(
  targetKey: string | undefined,
  request: PluginPromptInsertRequest,
): boolean {
  const listeners = promptInsertListeners.get(normalizeComposerTarget(targetKey));
  if (listeners === undefined) return false;
  let handled = false;
  for (const { listener } of [...listeners]) {
    if (listener(request)) handled = true;
  }
  return handled;
}

export function interpolatePluginPromptText(template: string, args?: string): string {
  const trimmedArgs = (args ?? '').trim();
  if (template.includes('$ARGUMENTS')) {
    const interpolated = template.replaceAll('$ARGUMENTS', trimmedArgs);
    return trimmedArgs === '' ? interpolated.replace(/[ \t]+$/gm, '') : interpolated;
  }
  return trimmedArgs === '' ? template : `${template}\n${trimmedArgs}`;
}
