import type { PermissionMode } from '@kiki/node-sdk';

import type { SettingsDialogItem } from '#/tui/components/dialogs/settings-dialog';
import type { BusySubmitMode, ScreenMode, TuiConfig } from '#/tui/config';
import type { AppState } from '#/tui/types';

export interface DaemonSettingsHost {
  readonly getAppState: () => AppState;
  readonly getScreenMode: () => ScreenMode;
  readonly getEffectiveMouse: () => boolean;
  readonly setBusySubmit: (mode: BusySubmitMode) => void;
  readonly setMouseReporting: (enabled: boolean) => void;
  readonly switchScreenMode: (mode: ScreenMode) => Promise<void>;
  readonly setShowThinking: (enabled: boolean) => void;
  readonly setShowTimestamps: (enabled: boolean) => void;
  readonly setRenderLatex: (enabled: boolean) => void;
  readonly setNotifications: (next: TuiConfig['notifications']) => void;
  readonly applyTheme: (theme: string) => Promise<void>;
  readonly applyPermission: (mode: PermissionMode) => Promise<void>;
  readonly applyPlanMode: (enabled: boolean) => Promise<void>;
  readonly openPermissionPicker: () => void;
  readonly openModelPicker: () => Promise<void>;
  readonly openThinkingPicker: () => Promise<void>;
  readonly showRedactedConfigJson: () => Promise<void>;
  readonly closeDialog: () => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Single source of truth for TUI settings items, shared by `/settings` and
 * the `Ctrl+P` / `/palette` command palette.
 */
export function buildDaemonSettingsItems(host: DaemonSettingsHost): SettingsDialogItem[] {
  const runAsync = (promise: Promise<void>): void => {
    void promise.catch((error: unknown) => host.onError(error));
  };

  return [
    {
      id: 'busy_submit',
      label: 'Busy Enter behavior',
      description: 'Send now steers the running turn; Queue waits for the next turn',
      getValue: () =>
        (host.getAppState().busySubmit ?? 'send_now') === 'send_now' ? 'Send now' : 'Queue',
      getValueTone: () => 'primary',
      onActivate: () => {
        const next: BusySubmitMode =
          (host.getAppState().busySubmit ?? 'send_now') === 'send_now' ? 'queue' : 'send_now';
        host.setBusySubmit(next);
      },
    },
    {
      id: 'mouse',
      label: 'Mouse reporting',
      description: 'Click & wheel navigation in fullscreen alt screen (Alt+M toggles)',
      getValue: () => (host.getEffectiveMouse() ? 'enabled' : 'disabled'),
      onActivate: () => {
        host.setMouseReporting(!host.getEffectiveMouse());
      },
    },
    {
      id: 'screen_mode',
      label: 'Screen mode',
      description: 'Switch live between main scrollback and fullscreen alt screen (/screen)',
      getValue: () =>
        host.getScreenMode() === 'alt' ? 'Fullscreen alt' : 'Main scrollback',
      getValueTone: () => 'primary',
      onActivate: () => {
        const next: ScreenMode = host.getScreenMode() === 'alt' ? 'main' : 'alt';
        runAsync(host.switchScreenMode(next));
      },
    },
    {
      id: 'show_thinking',
      label: 'Show thinking',
      description: 'Render model reasoning traces in the transcript',
      getValue: () => (host.getAppState().showThinking !== false ? 'enabled' : 'disabled'),
      onActivate: () => {
        host.setShowThinking(host.getAppState().showThinking === false);
      },
    },
    {
      id: 'show_timestamps',
      label: 'Prompt timestamps',
      description: 'Show HH:MM:SS above user prompts',
      getValue: () => (host.getAppState().showTimestamps === true ? 'enabled' : 'disabled'),
      onActivate: () => {
        host.setShowTimestamps(host.getAppState().showTimestamps !== true);
      },
    },
    {
      id: 'render_latex',
      label: 'LaTeX math',
      description: 'Format inline and block LaTeX equations in assistant replies',
      getValue: () => (host.getAppState().renderLatex !== false ? 'enabled' : 'disabled'),
      onActivate: () => {
        host.setRenderLatex(host.getAppState().renderLatex === false);
      },
    },
    {
      id: 'notifications',
      label: 'Notifications',
      description: 'Terminal bell / desktop notification when turns finish or need input',
      getValue: () => {
        const n = host.getAppState().notifications;
        if (!n.enabled) return 'disabled';
        return n.condition === 'always' ? 'Always' : 'Unfocused';
      },
      getValueTone: () =>
        host.getAppState().notifications.enabled ? 'success' : 'textDim',
      onActivate: () => {
        const cur = host.getAppState().notifications;
        const next = !cur.enabled
          ? { enabled: true, condition: 'unfocused' as const }
          : cur.condition === 'unfocused'
            ? { enabled: true, condition: 'always' as const }
            : { enabled: false, condition: cur.condition };
        host.setNotifications(next);
      },
    },
    {
      id: 'theme',
      label: 'Theme',
      description: 'Cycle auto, dark, and light color palettes',
      getValue: () => host.getAppState().theme,
      getValueTone: () => 'primary',
      onActivate: () => {
        const order = ['auto', 'dark', 'light'] as const;
        const curIdx = order.indexOf(host.getAppState().theme as (typeof order)[number]);
        const next = order[(curIdx + 1) % order.length]!;
        runAsync(host.applyTheme(next));
      },
    },
    {
      id: 'permission',
      label: 'Permission mode',
      description: 'Open permission selector (or Space to cycle)',
      getValue: () => host.getAppState().permissionMode,
      getValueTone: () => 'primary',
      onActivate: (trigger) => {
        if (trigger === 'space') {
          const modes: readonly PermissionMode[] = ['manual', 'auto', 'review', 'yolo'];
          const idx = modes.indexOf(host.getAppState().permissionMode);
          const next = modes[(idx + 1) % modes.length]!;
          runAsync(host.applyPermission(next));
          return;
        }
        host.closeDialog();
        host.openPermissionPicker();
      },
    },
    {
      id: 'plan',
      label: 'Plan mode',
      description: 'Read-only planning mode (Shift+Tab)',
      getValue: () => (host.getAppState().planMode ? 'enabled' : 'disabled'),
      onActivate: () => {
        runAsync(host.applyPlanMode(!host.getAppState().planMode));
      },
    },
    {
      id: 'model',
      label: 'Model',
      description: 'Switch active LLM model',
      getValue: () =>
        host.getAppState().model === '' ? 'not selected' : host.getAppState().model,
      getValueTone: () => (host.getAppState().model === '' ? 'textDim' : 'primary'),
      onActivate: () => {
        host.closeDialog();
        runAsync(host.openModelPicker());
      },
    },
    {
      id: 'effort',
      label: 'Thinking effort',
      description: 'Adjust model reasoning budget',
      getValue: () => host.getAppState().thinkingEffort,
      getValueTone: () =>
        host.getAppState().thinkingEffort === 'off' ? 'textDim' : 'primary',
      onActivate: () => {
        host.closeDialog();
        runAsync(host.openThinkingPicker());
      },
    },
    {
      id: 'config_json',
      label: 'View redacted daemon config',
      description: 'Print redacted config JSON to the transcript (/settings json)',
      getValue: () => 'open',
      getValueTone: () => 'textMuted',
      onActivate: () => {
        host.closeDialog();
        runAsync(host.showRedactedConfigJson());
      },
    },
  ];
}
