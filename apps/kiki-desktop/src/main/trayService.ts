import { setTimeout as delay } from 'node:timers/promises';
import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopSpace, LocalSpaceSummary } from '#/shared/types';
import type { StopManagedDaemonResult } from '#/main/daemonSupervisor';

export const TRAY_LOGON_RETRY_LIMIT = 12;
export const TRAY_LOGON_RETRY_DELAY_MS = 1_500;

export interface TrayCopy {
  readonly show: string;
  readonly hide: string;
  readonly newSession: string;
  readonly localSpaces: string;
  readonly openWindow: string;
  readonly stopBackground: string;
  readonly statusRunning: string;
  readonly statusBackground: string;
  readonly statusStopped: string;
  readonly autostart: string;
  readonly closeWindowKeepTray: string;
  readonly quitCompletely: string;
}

export function getTrayCopy(zh: boolean): TrayCopy {
  if (zh) {
    return {
      show: '打开主窗口',
      hide: '隐藏到托盘',
      newSession: '新建会话',
      localSpaces: '本地空间',
      openWindow: '打开窗口',
      stopBackground: '停止该空间后台服务',
      statusRunning: '运行中',
      statusBackground: '后台运行',
      statusStopped: '未运行',
      autostart: '开机自启（托盘驻留）',
      closeWindowKeepTray: '仅关闭窗口（保持托盘与后台）',
      quitCompletely: '完全退出（停止后台服务）',
    };
  }
  return {
    show: 'Open Main Window',
    hide: 'Hide to Tray',
    newSession: 'New Session',
    localSpaces: 'Local Spaces',
    openWindow: 'Open Window',
    stopBackground: 'Stop Background Server',
    statusRunning: 'Running',
    statusBackground: 'Background',
    statusStopped: 'Stopped',
    autostart: 'Start at Login (Tray)',
    closeWindowKeepTray: 'Close Window Only (Keep Tray)',
    quitCompletely: 'Quit Kiki Completely (Stop Services)',
  };
}

export function desktopExitCopy(zh: boolean): {
  readonly message: string;
  readonly confirmButton: string;
  readonly cancelButton: string;
} {
  if (zh) {
    return {
      message:
        '退出会停止本桌面连接的本机共享服务，断开其他客户端，并取消未完成的工作。其他空间、远端和外部管理的服务不受影响。关闭窗口可保留后台。',
      confirmButton: '停止服务并退出',
      cancelButton: '取消',
    };
  }
  return {
    message:
      'Quitting stops this desktop’s connected local shared services, disconnects other clients, and cancels unfinished work. Other spaces, remote and externally managed services are unaffected. Close the window to keep the backend running.',
    confirmButton: 'Stop services and quit',
    cancelButton: 'Cancel',
  };
}

export function formatTrayTooltip(options: {
  readonly spaces: readonly LocalSpaceSummary[];
  readonly activeSpace?: DesktopSpace | null;
  readonly windowVisible: boolean;
  readonly zh: boolean;
}): string {
  if (options.activeSpace !== undefined && options.activeSpace !== null && options.activeSpace.homeId !== 'main') {
    return `Kiki · ${options.activeSpace.name}`;
  }
  const running = options.spaces
    .filter((space) => space.status !== 'stopped')
    .map((space) => space.name);
  if (running.length === 0) {
    return 'Kiki';
  }
  const summary = running.join(', ');
  if (options.zh) {
    return options.windowVisible
      ? `Kiki · 运行中（${summary}）`
      : `Kiki · 后台运行中（${summary}）`;
  }
  return options.windowVisible
    ? `Kiki · Running (${summary})`
    : `Kiki · Running in background (${summary})`;
}

export interface TrayRetryOutcome {
  readonly trayCreated: boolean;
  readonly revealFallbackWindow: boolean;
  readonly attempts: number;
  readonly lastError?: string;
}

export async function retryTrayCreation(options: {
  readonly startInBackground: boolean;
  readonly isQuitting: () => boolean;
  readonly retryLimit?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly attemptCreate: () => void;
}): Promise<TrayRetryOutcome> {
  const retryLimit = options.retryLimit ?? TRAY_LOGON_RETRY_LIMIT;
  const delayMs = options.delayMs ?? TRAY_LOGON_RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms) => delay(ms));

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= retryLimit + 1; attempt += 1) {
    if (options.isQuitting()) {
      return {
        trayCreated: false,
        revealFallbackWindow: false,
        attempts: attempt - 1,
        lastError,
      };
    }
    try {
      options.attemptCreate();
      return {
        trayCreated: true,
        revealFallbackWindow: false,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt <= retryLimit) {
        await sleep(delayMs);
      }
    }
  }

  return {
    trayCreated: false,
    revealFallbackWindow: options.startInBackground && !options.isQuitting(),
    attempts: retryLimit + 1,
    lastError,
  };
}

export interface TrayMenuCallbacks {
  readonly onShowWindow: () => void;
  readonly onHideWindow: () => void;
  readonly onNewSession: () => void;
  readonly onOpenSpace: (homeId: string) => void;
  readonly onStopSpace: (homeId: string) => void;
  readonly onToggleAutostart: (enabled: boolean) => void;
  readonly onCloseWindowKeepTray: () => void;
  readonly onQuitCompletely: () => void;
}

export function buildTrayMenuTemplate(input: {
  readonly zh: boolean;
  readonly windowVisible: boolean;
  readonly autostartSupported: boolean;
  readonly autostartEnabled: boolean;
  readonly spaces: readonly LocalSpaceSummary[];
  readonly callbacks: TrayMenuCallbacks;
}): MenuItemConstructorOptions[] {
  const copy = getTrayCopy(input.zh);
  const statusLabel = (status: LocalSpaceSummary['status']): string => {
    if (status === 'running') return copy.statusRunning;
    if (status === 'background') return copy.statusBackground;
    return copy.statusStopped;
  };

  const items: MenuItemConstructorOptions[] = [
    {
      label: input.windowVisible ? copy.hide : copy.show,
      click: input.windowVisible ? input.callbacks.onHideWindow : input.callbacks.onShowWindow,
    },
    {
      label: copy.newSession,
      click: input.callbacks.onNewSession,
    },
  ];

  if (input.spaces.length > 0) {
    items.push({ type: 'separator' });
    items.push({
      label: copy.localSpaces,
      submenu: input.spaces.map((space) => ({
        label: `${space.name} (${statusLabel(space.status)})`,
        submenu: [
          {
            label: copy.openWindow,
            click: () => {
              input.callbacks.onOpenSpace(space.homeId);
            },
          },
          ...(space.status !== 'stopped' && space.managed !== false
            ? [
                {
                  label: copy.stopBackground,
                  click: () => {
                    input.callbacks.onStopSpace(space.homeId);
                  },
                },
              ]
            : []),
        ],
      })),
    });
  }

  items.push({ type: 'separator' });

  if (input.autostartSupported) {
    items.push({
      label: copy.autostart,
      type: 'checkbox',
      checked: input.autostartEnabled,
      click: (menuItem) => {
        input.callbacks.onToggleAutostart(menuItem.checked);
      },
    });
  }

  if (input.windowVisible) {
    items.push({
      label: copy.closeWindowKeepTray,
      click: input.callbacks.onCloseWindowKeepTray,
    });
  }

  items.push({
    label: copy.quitCompletely,
    click: input.callbacks.onQuitCompletely,
  });

  return items;
}

export interface TrayQuitDeps {
  readonly stopManagedDaemon: (options: {
    readonly action: 'quit';
    readonly interruptWork: boolean;
  }) => Promise<StopManagedDaemonResult>;
  readonly confirmInterruptPendingWork: (pendingWork: readonly string[]) => Promise<boolean>;
  readonly detachDesktop: () => void;
  readonly releaseQuit: () => void;
}

export async function executeTrayQuit(deps: TrayQuitDeps): Promise<{ readonly quit: boolean }> {
  try {
    const first = await deps.stopManagedDaemon({ action: 'quit', interruptWork: false });
    if (first.reason === 'pending-work') {
      const confirmed = await deps.confirmInterruptPendingWork(first.pendingWork ?? []);
      if (!confirmed) {
        return { quit: false };
      }
      await deps.stopManagedDaemon({ action: 'quit', interruptWork: true });
    }
  } catch {
    // Never trap the user in an unquittable window if the daemon is unreachable during quit.
  }
  deps.detachDesktop();
  deps.releaseQuit();
  return { quit: true };
}

export interface StopBackgroundSpaceDeps {
  readonly spaceName: string;
  readonly spacePath: string;
  readonly confirmStopSpace: (spaceName: string) => Promise<boolean>;
  readonly stopManagedDaemonForHome: (
    homeDir: string,
    options: { readonly action: 'quit'; readonly interruptWork: boolean },
  ) => Promise<StopManagedDaemonResult>;
}

export async function executeStopBackgroundSpace(
  deps: StopBackgroundSpaceDeps,
): Promise<StopManagedDaemonResult | { readonly stopped: false; readonly reason: 'cancelled' }> {
  const confirmed = await deps.confirmStopSpace(deps.spaceName);
  if (!confirmed) {
    return { stopped: false, reason: 'cancelled' };
  }
  return deps.stopManagedDaemonForHome(deps.spacePath, {
    action: 'quit',
    interruptWork: true,
  });
}
