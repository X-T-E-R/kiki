import { z } from 'zod';

export const shortcutPlatformSchema = z.enum(['windows', 'macos', 'linux']);
export type ShortcutPlatform = z.infer<typeof shortcutPlatformSchema>;
export const shortcutActionSchema = z.enum([
  'new-session', 'switcher', 'next-session', 'settings', 'shortcuts', 'shortcuts-help',
  'find', 'find-next', 'find-previous', 'terminal-toggle', 'terminal-copy', 'terminal-paste',
  'approve', 'reject', 'composer-mode', 'composer-undo', 'composer-redo',
]);
export type ShortcutAction = z.infer<typeof shortcutActionSchema>;
export const shortcutChordSchema = z.object({
  key: z.string().min(1).max(32).refine((key) => key.length === 1 && !/[\u0000-\u001F\u007F]/u.test(key) || /^(?:Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F(?:[1-9]|1[0-9]|2[0-4]))$/u.test(key), 'Use a KeyboardEvent.key value'),
  modifier: z.enum(['none', 'mod', 'ctrl', 'meta', 'ctrl-meta']).default('none'),
  shift: z.boolean().default(false),
  alt: z.boolean().default(false),
}).strict();
export type ShortcutChord = z.infer<typeof shortcutChordSchema>;
export const shortcutBindingsSchema = z.partialRecord(shortcutActionSchema, z.array(shortcutChordSchema).max(4));
export const shortcutPreferencesSchema = z.object({
  version: z.literal(1),
  overrides: z.object({
    windows: shortcutBindingsSchema.optional(),
    macos: shortcutBindingsSchema.optional(),
    linux: shortcutBindingsSchema.optional(),
  }).strict(),
}).strict();
export type ShortcutPreferences = z.infer<typeof shortcutPreferencesSchema>;
export const DEFAULT_SHORTCUT_PREFERENCES: ShortcutPreferences = { version: 1, overrides: {} };

const chord = (key: string, modifier: ShortcutChord['modifier'] = 'none', shift = false): ShortcutChord => ({ key, modifier, shift, alt: false });
export interface ShortcutDefinition {
  readonly id: ShortcutAction;
  readonly context: 'global' | 'session' | 'composer' | 'approval' | 'terminal';
  readonly labelKey: string;
  readonly defaults: readonly ShortcutChord[];
  readonly desktopOnly: boolean;
  readonly source: string;
}
/** Application actions only; text editing, menu navigation and layered Escape remain owned by their handlers. */
export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: 'new-session', context: 'global', labelKey: 'shortcuts.newSession', defaults: [chord('n', 'mod')], desktopOnly: true, source: 'App.tsx' },
  { id: 'switcher', context: 'global', labelKey: 'shortcuts.switcher', defaults: [chord('k', 'mod')], desktopOnly: false, source: 'App.tsx' },
  { id: 'next-session', context: 'global', labelKey: 'shortcuts.nextSession', defaults: [chord('Tab', 'ctrl')], desktopOnly: true, source: 'App.tsx' },
  { id: 'settings', context: 'global', labelKey: 'shortcuts.settings', defaults: [chord(',', 'mod')], desktopOnly: false, source: 'App.tsx' },
  { id: 'shortcuts', context: 'global', labelKey: 'shortcuts.thisPanel', defaults: [chord('/', 'mod')], desktopOnly: false, source: 'App.tsx' },
  { id: 'shortcuts-help', context: 'global', labelKey: 'shortcuts.thisPanel', defaults: [chord('?', 'none', true)], desktopOnly: false, source: 'App.tsx (outside editable surfaces)' },
  { id: 'find', context: 'global', labelKey: 'shortcuts.find', defaults: [chord('f', 'mod')], desktopOnly: false, source: 'lib/timelineFind.ts (session/settings routes)' },
  { id: 'find-next', context: 'session', labelKey: 'shortcuts.findNext', defaults: [chord('F3')], desktopOnly: false, source: 'lib/timelineFind.ts' },
  { id: 'find-previous', context: 'session', labelKey: 'shortcuts.findPrevious', defaults: [chord('F3', 'none', true)], desktopOnly: false, source: 'lib/timelineFind.ts' },
  { id: 'terminal-toggle', context: 'session', labelKey: 'shortcuts.termToggle', defaults: [chord('`', 'ctrl')], desktopOnly: false, source: 'SessionView.tsx' },
  { id: 'terminal-copy', context: 'terminal', labelKey: 'shortcuts.termCopy', defaults: [chord('c', 'ctrl', true)], desktopOnly: false, source: 'TerminalPanel.tsx' },
  { id: 'terminal-paste', context: 'terminal', labelKey: 'shortcuts.termPaste', defaults: [chord('v', 'ctrl', true)], desktopOnly: false, source: 'TerminalPanel.tsx' },
  { id: 'approve', context: 'approval', labelKey: 'shortcuts.approve', defaults: [chord('y')], desktopOnly: false, source: 'SessionView.tsx (outside editable surfaces)' },
  { id: 'reject', context: 'approval', labelKey: 'shortcuts.reject', defaults: [chord('n')], desktopOnly: false, source: 'SessionView.tsx (outside editable surfaces)' },
  { id: 'composer-mode', context: 'composer', labelKey: 'composer.modeAria', defaults: [chord('m', 'mod', true)], desktopOnly: false, source: 'Composer.tsx' },
  { id: 'composer-undo', context: 'composer', labelKey: 'shortcuts.undo', defaults: [chord('z', 'mod')], desktopOnly: false, source: 'Composer.tsx' },
  { id: 'composer-redo', context: 'composer', labelKey: 'shortcuts.redo', defaults: [chord('z', 'mod', true)], desktopOnly: false, source: 'Composer.tsx' },
];

export interface FixedShortcutDefinition {
  readonly id: string;
  readonly context: string;
  readonly labelKey: string;
  readonly defaults: readonly ShortcutChord[];
  readonly desktopOnly: boolean;
  readonly source: string;
  readonly managedBy: 'sendShortcut' | 'interaction' | 'desktop';
}
/** Complete discoverability catalog. Fixed interaction keys are not remapping actions. */
export const SHORTCUT_CATALOG: readonly (ShortcutDefinition | FixedShortcutDefinition)[] = [
  ...SHORTCUT_DEFINITIONS,
  { id: 'send', context: 'composer', labelKey: 'shortcuts.send', defaults: [chord('Enter')], desktopOnly: false, source: 'settings.ts composerEnterAction (sendShortcut=enter)', managedBy: 'sendShortcut' },
  { id: 'send-now', context: 'composer', labelKey: 'shortcuts.send', defaults: [chord('Enter', 'mod')], desktopOnly: false, source: 'settings.ts composerEnterAction (sendShortcut=enter)', managedBy: 'sendShortcut' },
  { id: 'newline', context: 'composer', labelKey: 'shortcuts.newline', defaults: [chord('Enter', 'none', true)], desktopOnly: false, source: 'settings.ts composerEnterAction (sendShortcut=enter)', managedBy: 'sendShortcut' },
  { id: 'escape-overlay', context: 'overlay', labelKey: 'shortcuts.escOverlay', defaults: [chord('Escape')], desktopOnly: false, source: 'Dialog.tsx / Composer.tsx', managedBy: 'interaction' },
  { id: 'escape-terminal', context: 'terminal', labelKey: 'shortcuts.escTerminal', defaults: [chord('Escape')], desktopOnly: false, source: 'SessionView.tsx / TerminalPanel.tsx (PTY focus has priority)', managedBy: 'interaction' },
  { id: 'escape-abort', context: 'session', labelKey: 'shortcuts.escAbort', defaults: [chord('Escape')], desktopOnly: false, source: 'SessionView.tsx (after overlay/terminal)', managedBy: 'interaction' },
  { id: 'escape-settings', context: 'settings', labelKey: 'shortcuts.escOverlay', defaults: [chord('Escape')], desktopOnly: false, source: 'App.tsx (outside editable surfaces/overlays)', managedBy: 'interaction' },
  { id: 'slash-menu', context: 'composer', labelKey: 'shortcuts.slashMenu', defaults: [chord('/')], desktopOnly: false, source: 'Composer.tsx (text trigger)', managedBy: 'interaction' },
  { id: 'file-mention', context: 'composer', labelKey: 'shortcuts.fileMention', defaults: [chord('@')], desktopOnly: false, source: 'Composer.tsx (text trigger)', managedBy: 'interaction' },
  { id: 'history-previous', context: 'composer', labelKey: 'composer.history.previous', defaults: [chord('ArrowUp')], desktopOnly: false, source: 'Composer.tsx (menu closed/history cursor)', managedBy: 'interaction' },
  { id: 'history-next', context: 'composer', labelKey: 'composer.history.next', defaults: [chord('ArrowDown')], desktopOnly: false, source: 'Composer.tsx (menu closed/history cursor)', managedBy: 'interaction' },
  { id: 'desktop-show-hide', context: 'global', labelKey: 'shortcuts.showHide', defaults: [chord('k', 'ctrl', true)], desktopOnly: true, source: 'src-tauri/src/lib.rs', managedBy: 'desktop' },
];

export function resolveShortcutBindings(preferences: ShortcutPreferences, platform: ShortcutPlatform): Record<ShortcutAction, ShortcutChord[]> {
  return Object.fromEntries(SHORTCUT_DEFINITIONS.map((definition) => [definition.id,
    preferences.overrides[platform]?.[definition.id] ?? [...definition.defaults],
  ])) as Record<ShortcutAction, ShortcutChord[]>;
}

export interface ShortcutKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}
/** `mod` preserves the GUI's existing Ctrl-or-Meta semantics on all platforms. */
export function matchesShortcut(event: ShortcutKeyEvent, binding: ShortcutChord): boolean {
  if (event.isComposing === true || event.key.toLowerCase() !== binding.key.toLowerCase() || event.shiftKey !== binding.shift || event.altKey !== binding.alt) return false;
  switch (binding.modifier) {
    case 'mod': return event.ctrlKey || event.metaKey;
    case 'ctrl': return event.ctrlKey && !event.metaKey;
    case 'meta': return event.metaKey && !event.ctrlKey;
    case 'ctrl-meta': return event.ctrlKey && event.metaKey;
    case 'none': return !event.ctrlKey && !event.metaKey;
  }
}

export const shortcutConflictSchema = z.object({
  platform: shortcutPlatformSchema,
  actions: z.array(shortcutActionSchema),
  kind: z.enum(['duplicate', 'reserved']),
  key: z.string(),
});
export type ShortcutConflict = z.infer<typeof shortcutConflictSchema>;
function chordsOverlap(a: ShortcutChord, b: ShortcutChord): boolean {
  return [0, 1, 2, 3].some((mask) => {
    const event = { key: a.key, shiftKey: a.shift, altKey: a.alt, ctrlKey: (mask & 1) !== 0, metaKey: (mask & 2) !== 0 };
    return matchesShortcut(event, a) && matchesShortcut(event, b);
  });
}
export function detectShortcutConflicts(preferences: ShortcutPreferences, platform: ShortcutPlatform): ShortcutConflict[] {
  const bindings = resolveShortcutBindings(preferences, platform);
  const conflicts: ShortcutConflict[] = [];
  for (const [index, a] of SHORTCUT_DEFINITIONS.entries()) {
    for (const b of SHORTCUT_DEFINITIONS.slice(index + 1)) {
      const overlap = a.context === b.context || a.context === 'global' || b.context === 'global' || a.context === 'session' || b.context === 'session';
      if (!overlap) continue;
      for (const left of bindings[a.id]) for (const right of bindings[b.id]) {
        if (chordsOverlap(left, right)) conflicts.push({ platform, actions: [a.id, b.id], kind: 'duplicate', key: left.key });
      }
    }
    for (const [bindingIndex, binding] of bindings[a.id].entries()) {
      for (const other of bindings[a.id].slice(bindingIndex + 1)) {
        if (chordsOverlap(binding, other)) conflicts.push({ platform, actions: [a.id], kind: 'duplicate', key: binding.key });
      }
      const reserved = binding.key.toLowerCase() === 'enter' || binding.key.toLowerCase() === 'escape' ||
        (a.context === 'global' || a.context === 'composer' || a.context === 'session') &&
          (binding.modifier === 'none' && ['/', '@', 'ArrowUp', 'ArrowDown'].includes(binding.key)) ||
        chordsOverlap(binding, chord('k', 'ctrl', true)) ||
        (platform === 'macos' ? chordsOverlap(binding, chord('q', 'meta')) || chordsOverlap(binding, chord('w', 'meta')) :
          binding.key.toLowerCase() === 'f4' && binding.alt);
      if (reserved) conflicts.push({ platform, actions: [a.id], kind: 'reserved', key: binding.key });
    }
  }
  return conflicts;
}
export function resetShortcutPreferences(preferences: ShortcutPreferences, platform?: ShortcutPlatform, action?: ShortcutAction): ShortcutPreferences {
  const next = shortcutPreferencesSchema.parse(preferences);
  for (const target of platform === undefined ? shortcutPlatformSchema.options : [platform]) {
    if (action === undefined) delete next.overrides[target];
    else if (next.overrides[target] !== undefined) delete next.overrides[target][action];
  }
  return next;
}
export function shortcutModifierLabel(binding: ShortcutChord, platform: ShortcutPlatform): string {
  return binding.modifier === 'mod' ? platform === 'macos' ? '⌘/Ctrl' : 'Ctrl/Meta' :
    binding.modifier === 'meta' ? platform === 'macos' ? '⌘' : 'Meta' : binding.modifier === 'ctrl' ? 'Ctrl' : binding.modifier === 'ctrl-meta' ? 'Ctrl+Meta' : '';
}

export const shortcutReadQuerySchema = z.object({ platform: shortcutPlatformSchema });
export const shortcutWriteSchema = z.object({ preferences: shortcutPreferencesSchema }).strict();
export const shortcutResetSchema = z.object({ platform: shortcutPlatformSchema.optional(), action: shortcutActionSchema.optional() }).strict();
export const shortcutResponseSchema = z.object({
  preferences: shortcutPreferencesSchema,
  bindings: z.record(shortcutActionSchema, z.array(shortcutChordSchema)),
  conflicts: z.array(shortcutConflictSchema),
});
export type ShortcutResponse = z.infer<typeof shortcutResponseSchema>;
