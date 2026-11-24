/**
 * Client-owned preferences.
 *
 * Agent/runtime settings live in core's `config.toml`; this file owns
 * kimi-code client preferences such as terminal UI behavior.
 */

import { existsSync } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { getDataDir } from '#/utils/paths';
import { writeTextFileAtomic } from '#/utils/persistence';

export const INVALID_TUI_CONFIG_MESSAGE =
  'Invalid TUI config in ~/.kiki/tui.toml; using defaults.';

export const TuiThemeSchema = z.string();

export const BusySubmitModeSchema = z.enum(['send_now', 'queue']);
export type BusySubmitMode = z.infer<typeof BusySubmitModeSchema>;

export const ScreenModeSchema = z.enum(['main', 'alt']);
export type ScreenMode = z.infer<typeof ScreenModeSchema>;

export const NotificationConditionSchema = z.enum(['unfocused', 'always']);

export const NotificationsConfigSchema = z.object({
  enabled: z.boolean(),
  condition: NotificationConditionSchema,
});

export const STATUS_LINE_ITEMS = ['mode', 'goal', 'model', 'tasks', 'cwd', 'git', 'tips'] as const;
export type StatusLineItem = (typeof STATUS_LINE_ITEMS)[number];

export const StatusLineFileConfigSchema = z.object({
  items: z.array(z.string()).optional(),
  command: z.string().optional(),
});

export const StatusLineConfigSchema = z.object({
  /** Ordered built-in slots for footer line 1; null means the default layout. */
  items: z.array(z.enum(STATUS_LINE_ITEMS)).nullable(),
  /** User command whose first stdout line replaces footer line 1; null disables. */
  command: z.string().nullable(),
});
export type StatusLineConfig = z.infer<typeof StatusLineConfigSchema>;

export const DEFAULT_STATUS_LINE_CONFIG: StatusLineConfig = {
  items: null,
  command: null,
};

export const TuiConfigFileSchema = z.object({
  theme: TuiThemeSchema.optional(),
  busy_submit: BusySubmitModeSchema.optional(),
  mouse: z.boolean().optional(),
  screen_mode: ScreenModeSchema.optional(),
  show_thinking: z.boolean().optional(),
  show_timestamps: z.boolean().optional(),
  render_latex: z.boolean().optional(),
  disable_paste_burst: z.boolean().optional(),
  cache_expiry_hint: z.boolean().optional(),
  favorite_models: z.array(z.string()).optional(),
  recent_models: z.array(z.string()).optional(),
  editor: z
    .object({
      command: z.string().optional(),
    })
    .optional(),
  notifications: z
    .object({
      enabled: z.boolean().optional(),
      notification_condition: NotificationConditionSchema.optional(),
    })
    .optional(),
  status_line: StatusLineFileConfigSchema.optional(),
});

export const TuiConfigSchema = z.object({
  theme: TuiThemeSchema,
  /** Busy Enter behavior in the TUI ('send_now' steers immediately; 'queue' queues for next turn). */
  busySubmit: BusySubmitModeSchema.optional(),
  /** SGR mouse click & wheel reporting; optional only so older hand-built test fixtures typecheck. */
  mouse: z.boolean().optional(),
  /** Terminal screen mode ('main' native scrollback | 'alt' fullscreen viewport). */
  screenMode: ScreenModeSchema.optional(),
  /** Whether thinking traces render in the transcript; defaults to true. */
  showThinking: z.boolean().optional(),
  /** Whether prompt timestamps render in the transcript; defaults to false. */
  showTimestamps: z.boolean().optional(),
  /** LaTeX math rendering in Markdown; optional only so older hand-built test
   * fixtures still typecheck. */
  renderLatex: z.boolean().optional(),
  disablePasteBurst: z.boolean(),
  /** Present in every normalized config; optional only so hand-built test
   * fixtures from before this field existed still typecheck. */
  cacheExpiryHint: z.boolean().optional(),
  favoriteModels: z.array(z.string()).optional(),
  recentModels: z.array(z.string()).optional(),
  editorCommand: z.string().nullable(),
  notifications: NotificationsConfigSchema,
  /** Present in every normalized config; optional only so hand-built test
   * fixtures from before this field existed still typecheck. */
  statusLine: StatusLineConfigSchema.optional(),
});

export type TuiConfigFileShape = z.infer<typeof TuiConfigFileSchema>;
export type TuiConfig = z.infer<typeof TuiConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

export const DEFAULT_NOTIFICATIONS_CONFIG: NotificationsConfig = {
  enabled: true,
  condition: 'unfocused',
};

export const DEFAULT_TUI_CONFIG: TuiConfig = TuiConfigSchema.parse({
  theme: 'auto',
  busySubmit: 'send_now',
  screenMode: 'main',
  showThinking: true,
  showTimestamps: false,
  renderLatex: true,
  disablePasteBurst: false,
  cacheExpiryHint: true,
  editorCommand: null,
  notifications: DEFAULT_NOTIFICATIONS_CONFIG,
  statusLine: DEFAULT_STATUS_LINE_CONFIG,
});

export interface ResolvedScreenAndMouse {
  readonly screenMode: ScreenMode;
  readonly effectiveMouse: boolean;
  readonly savedMouse: boolean | undefined;
  readonly envOverride: ScreenMode | undefined;
}

/**
 * Resolve effective screen mode and mouse capture state.
 * - Default first launch: `main` with effective mouse OFF (never hijacks host scrollback).
 * - Explicit fullscreen (`alt`): mouse ON unless saved preference is explicitly `false`.
 * - Legacy persisted `main + mouse=true` does not reactivate main mouse capture; the saved
 *   preference is remembered for `alt`.
 */
export function resolveEffectiveScreenAndMouse(
  config: Pick<TuiConfig, 'screenMode' | 'mouse'>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedScreenAndMouse {
  const rawEnv = env['KIKI_TUI_FULL_SCREEN'];
  const envOverride: ScreenMode | undefined =
    rawEnv === '1' ? 'alt' : rawEnv === '0' ? 'main' : undefined;
  const screenMode: ScreenMode = envOverride ?? config.screenMode ?? 'main';
  const savedMouse = config.mouse;
  const effectiveMouse = screenMode === 'alt' && (savedMouse ?? true);
  return { screenMode, effectiveMouse, savedMouse, envOverride };
}

/**
 * Thrown by `loadTuiConfig` when the on-disk TOML cannot be parsed.
 * Carries `fallback` so the caller can recover without re-running the
 * I/O, and use `message` (== `INVALID_TUI_CONFIG_MESSAGE`) as a
 * user-facing notice.
 */
export class TuiConfigParseError extends Error {
  override readonly name = 'TuiConfigParseError';
  readonly fallback: TuiConfig;
  constructor(fallback: TuiConfig) {
    super(INVALID_TUI_CONFIG_MESSAGE);
    this.fallback = fallback;
  }
}

export function getTuiConfigPath(): string {
  return join(getDataDir(), 'tui.toml');
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export async function loadTuiConfig(
  filePath: string = getTuiConfigPath(),
  warn?: (message: string) => void,
): Promise<TuiConfig> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) {
      await saveTuiConfig(DEFAULT_TUI_CONFIG, filePath);
      return DEFAULT_TUI_CONFIG;
    }
    throw error;
  }

  try {
    return parseTuiConfig(text, warn);
  } catch {
    throw new TuiConfigParseError(DEFAULT_TUI_CONFIG);
  }
}

export function parseTuiConfig(
  tomlText: string,
  warn?: (message: string) => void,
): TuiConfig {
  if (tomlText.trim().length === 0) {
    return DEFAULT_TUI_CONFIG;
  }
  const raw = parseToml(tomlText) as Record<string, unknown>;
  const parsed = TuiConfigFileSchema.parse(raw);
  return normalizeTuiConfig(parsed, warn);
}

async function backupCorruptTuiConfig(filePath: string): Promise<void> {
  const ts = Date.now();
  let backupPath = `${filePath}.corrupt-${ts}`;
  if (existsSync(backupPath)) {
    backupPath = `${filePath}.corrupt-${ts}-${Math.random().toString(16).slice(2, 10)}`;
  }
  await rename(filePath, backupPath);
}

export async function saveTuiConfig(
  config: TuiConfig,
  filePath: string = getTuiConfigPath(),
): Promise<void> {
  let existingText: string | undefined;
  try {
    existingText = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  if (existingText !== undefined) {
    let existingValid = true;
    try {
      parseTuiConfig(existingText, () => {});
    } catch {
      existingValid = false;
    }
    if (!existingValid) {
      await backupCorruptTuiConfig(filePath);
    }
  }
  await writeTextFileAtomic(filePath, renderTuiConfig(config), { sync: true });
}

export function normalizeTuiConfig(
  config: TuiConfigFileShape,
  warn: (message: string) => void = (message) => {
    // oxlint-disable-next-line no-console
    console.warn(message);
  },
): TuiConfig {
  const command = config.editor?.command?.trim();
  const statusLineCommand = config.status_line?.command?.trim();
  const knownItems = new Set<string>(STATUS_LINE_ITEMS);
  const statusLineItems =
    config.status_line?.items
      ?.filter((item) => {
        const known = knownItems.has(item);
        if (!known) {
          warn(`[tui.toml] ignoring unknown status_line item: ${item}`);
        }
        return known;
      })
      .map((item) => item as StatusLineItem) ?? null;
  const normalized: Record<string, unknown> = {
    theme: config.theme ?? DEFAULT_TUI_CONFIG.theme,
    busySubmit: config.busy_submit ?? DEFAULT_TUI_CONFIG.busySubmit,
    screenMode: config.screen_mode ?? DEFAULT_TUI_CONFIG.screenMode,
    showThinking: config.show_thinking ?? DEFAULT_TUI_CONFIG.showThinking,
    showTimestamps: config.show_timestamps ?? DEFAULT_TUI_CONFIG.showTimestamps,
    renderLatex: config.render_latex ?? DEFAULT_TUI_CONFIG.renderLatex,
    disablePasteBurst: config.disable_paste_burst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
    cacheExpiryHint: config.cache_expiry_hint ?? DEFAULT_TUI_CONFIG.cacheExpiryHint,
    editorCommand: command === undefined || command.length === 0 ? null : command,
    notifications: {
      enabled: config.notifications?.enabled ?? DEFAULT_NOTIFICATIONS_CONFIG.enabled,
      condition:
        config.notifications?.notification_condition ?? DEFAULT_NOTIFICATIONS_CONFIG.condition,
    },
    statusLine: {
      items: statusLineItems,
      command:
        statusLineCommand === undefined || statusLineCommand.length === 0
          ? null
          : statusLineCommand,
    },
  };
  if (config.mouse !== undefined) normalized['mouse'] = config.mouse;
  if (config.favorite_models !== undefined) normalized['favoriteModels'] = config.favorite_models;
  if (config.recent_models !== undefined) normalized['recentModels'] = config.recent_models;
  return TuiConfigSchema.parse(normalized);
}

export function renderTuiConfig(config: TuiConfig): string {
  // An active status_line must round-trip: any preference save rewrites the
  // whole file, so the section is emitted live when set and left as a
  // commented-out guide when unset.
  const statusItems = config.statusLine?.items;
  const statusCommand = config.statusLine?.command;
  const statusLines: string[] = [];
  if (statusItems !== null && statusItems !== undefined) {
    statusLines.push(`items = ${JSON.stringify(statusItems)}`);
  }
  if (statusCommand) {
    statusLines.push(`command = "${escapeTomlBasicString(statusCommand)}"`);
  }
  const statusSection =
    statusLines.length > 0
      ? `[status_line]\n${statusLines.join('\n')}\n`
      : `# [status_line]
# Pick and order the built-in footer slots: ${STATUS_LINE_ITEMS.join(', ')}
# items = ${JSON.stringify([...STATUS_LINE_ITEMS])}
# Or render your own: a command whose first stdout line replaces footer line 1.
# It receives a JSON snapshot (model, cwd, git, usage, mode) on stdin.
# command = "~/.kiki/statusline.sh"
`;
  const busySubmit = config.busySubmit ?? 'send_now';
  const screenMode = config.screenMode ?? 'main';
  const mouseLine =
    config.mouse === undefined
      ? '# mouse = true # auto (on in alt, off in main) — set true | false to override fullscreen mouse capture (Alt+M toggles)'
      : `mouse = ${String(config.mouse)} # true | false — fullscreen SGR mouse click & wheel reporting (Alt+M toggles)`;
  const modelListLines: string[] = [];
  if (config.favoriteModels !== undefined && config.favoriteModels.length > 0) {
    modelListLines.push(`favorite_models = ${JSON.stringify(config.favoriteModels)}`);
  }
  if (config.recentModels !== undefined && config.recentModels.length > 0) {
    modelListLines.push(`recent_models = ${JSON.stringify(config.recentModels)}`);
  }
  const modelListBlock = modelListLines.length > 0 ? `\n${modelListLines.join('\n')}` : '';
  return `# ~/.kiki/tui.toml
# Client preferences for kimi-code.
# Agent/runtime settings stay in ~/.kiki/config.toml.

theme = "${escapeTomlBasicString(config.theme)}" # "auto" | "dark" | "light" | custom theme name
busy_submit = "${busySubmit}" # "send_now" | "queue" — plain Enter behavior while a turn runs
${mouseLine}
screen_mode = "${screenMode}" # "main" | "alt" — native scrollback vs fullscreen alternate screen
show_thinking = ${String(config.showThinking !== false)} # true | false — render thinking traces
show_timestamps = ${String(config.showTimestamps === true)} # true | false — show prompt timestamps
render_latex = ${String(config.renderLatex !== false)} # false keeps LaTeX math in assistant messages as raw source
disable_paste_burst = ${String(config.disablePasteBurst)} # true disables non-bracketed paste-burst fallback
cache_expiry_hint = ${String(config.cacheExpiryHint !== false)} # false disables the "cache expired" dialog on resume / idle submit${modelListBlock}

[editor]
command = "${escapeTomlBasicString(config.editorCommand ?? '')}" # Empty uses $VISUAL / $EDITOR

[notifications]
enabled = ${String(config.notifications.enabled)} # true | false
notification_condition = "${config.notifications.condition}" # "unfocused" | "always"

${statusSection}`;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\f', '\\f')
    .replaceAll('\r', '\\r');
}
