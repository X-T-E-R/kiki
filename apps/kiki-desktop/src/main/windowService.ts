import { spawn, type SpawnOptions } from 'node:child_process';
import { filterGuiChildEnv, resolveChildWorkingDir } from '#/main/releaseRedirect';
import { validateExternalUrl } from '#/main/fileAndClipboardService';
import type { DesktopWindowMode, SpaceWindowMode } from '#/shared/types';

export interface WindowCloseEventLike {
  preventDefault(): void;
}

export interface ManagedWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  hide(): void;
  setFullScreen(flag: boolean): void;
  once(event: 'leave-full-screen', listener: () => void): unknown;
  reload(): void;
  loadURL(url: string): Promise<void>;
  setZoomFactor(factor: number): void;
  close(): void;
}

export interface WindowServiceDeps {
  readonly platform?: NodeJS.Platform;
  readonly windowMode: DesktopWindowMode;
  readonly spaceWindowMode: SpaceWindowMode;
  readonly startWindowless: boolean;
  readonly getCloseToTray: () => boolean;
  readonly isTrayActive: () => boolean;
  readonly createBrowserWindow: (initialUrl: string) => Promise<ManagedWindowLike>;
  readonly getDaemonOrigin: () => string | null;
  readonly ensureDaemonOrigin: () => Promise<string>;
  readonly detachDesktop: () => void;
  readonly releaseAppQuit: () => void;
  readonly setDockVisible?: (visible: boolean) => void;
  readonly setNativeTheme?: (theme: 'light' | 'dark') => void;
  readonly resolveLaunchExecutable: () => string;
  readonly currentExe?: string;
  readonly currentDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnSibling?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => { unref?: () => void };
}

export function buildBootstrapDataUrl(): string {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>Kiki</title>' +
    '<style>html,body{height:100%;margin:0;display:grid;place-items:center;' +
    'font:14px/1.5 system-ui,-apple-system,sans-serif;background:#fafaf9;color:#1c1917}' +
    '@media(prefers-color-scheme:dark){html,body{background:#121212;color:#f5f5f4}}</style></head>' +
    '<body><div>Starting Kiki…</div></body></html>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function isAllowedRendererNavigation(targetUrl: string, daemonOrigin: string | null): boolean {
  if (targetUrl.startsWith('data:text/html')) return true;
  if (daemonOrigin === null) return false;
  try {
    const parsedTarget = new URL(targetUrl);
    const parsedOrigin = new URL(daemonOrigin);
    return parsedTarget.origin === parsedOrigin.origin;
  } catch {
    return false;
  }
}

export function shouldBlockRendererAccelerator(input: {
  readonly type: string;
  readonly key: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}): boolean {
  if (input.type !== 'keyDown') return false;
  const key = input.key.toLowerCase();
  if (key === 'f5') return true;
  const primary = input.control || input.meta;
  if (primary && !input.alt && (key === 'r' || key === 'p')) return true;
  return false;
}

export function tryValidateExternalForNavigation(rawUrl: string): string | null {
  try {
    return validateExternalUrl(rawUrl);
  } catch {
    return null;
  }
}

export class WindowService {
  private readonly platform: NodeJS.Platform;
  private mainWindow: ManagedWindowLike | null = null;
  private creatingWindow: Promise<ManagedWindowLike> | null = null;
  private quitting = false;

  constructor(private readonly deps: WindowServiceDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  get isQuitting(): boolean {
    return this.quitting;
  }

  get currentWindow(): ManagedWindowLike | null {
    if (this.mainWindow !== null && this.mainWindow.isDestroyed()) {
      this.mainWindow = null;
    }
    return this.mainWindow;
  }

  getWindowMode(): DesktopWindowMode {
    return this.deps.windowMode;
  }

  applyInitialWindowlessPolicy(): void {
    if (this.deps.startWindowless && this.platform === 'darwin') {
      this.deps.setDockVisible?.(false);
    }
  }

  shouldPreventQuitOnAllWindowsClosed(): boolean {
    return !this.quitting && this.deps.isTrayActive();
  }

  async showMainWindow(): Promise<ManagedWindowLike | null> {
    if (this.quitting) return null;
    if (this.platform === 'darwin') {
      this.deps.setDockVisible?.(true);
    }
    let win = this.currentWindow;
    if (win === null) {
      if (this.creatingWindow === null) {
        const initialUrl = this.deps.getDaemonOrigin() ?? buildBootstrapDataUrl();
        this.creatingWindow = this.deps.createBrowserWindow(initialUrl).finally(() => {
          this.creatingWindow = null;
        });
      }
      win = await this.creatingWindow;
      this.mainWindow = win;
    }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    return win;
  }

  async navigateToDaemonOrigin(origin: string): Promise<void> {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')) {
      throw new Error(`Refusing non-loopback daemon origin: ${origin}`);
    }
    const win = this.currentWindow;
    if (win === null) return;
    await win.loadURL(`${parsed.origin}/`);
  }

  hideMainWindow(): void {
    const win = this.currentWindow;
    if (win === null) return;
    if (this.platform === 'darwin' && win.isFullScreen()) {
      win.once('leave-full-screen', () => {
        if (!win.isDestroyed()) win.hide();
      });
      win.setFullScreen(false);
      return;
    }
    win.hide();
  }

  onWindowClose(event: WindowCloseEventLike): void {
    if (this.quitting) return;
    if (this.deps.getCloseToTray() && this.deps.isTrayActive()) {
      event.preventDefault();
      this.hideMainWindow();
      return;
    }
    // Closing the desktop UI when close_to_tray=false detaches desktop ownership
    // and leaves a ready shared kiki-server daemon alive.
    this.quitting = true;
    this.deps.detachDesktop();
    this.deps.releaseAppQuit();
  }

  onWindowClosed(closedWindow: ManagedWindowLike): void {
    if (this.mainWindow === closedWindow) {
      this.mainWindow = null;
    }
  }

  markQuitting(): void {
    this.quitting = true;
  }

  isVisibleAndFocused(): boolean {
    const win = this.currentWindow;
    if (win === null) return false;
    return win.isVisible() && win.isFocused();
  }

  setTheme(theme: 'light' | 'dark'): void {
    this.deps.setNativeTheme?.(theme);
  }

  setZoom(factor: number): boolean {
    const win = this.currentWindow;
    if (win === null || !Number.isFinite(factor) || factor <= 0) return false;
    win.setZoomFactor(factor);
    return true;
  }

  async reloadForSwitchedSpace(): Promise<void> {
    const origin = await this.deps.ensureDaemonOrigin();
    const win = await this.showMainWindow();
    if (win === null) return;
    await win.loadURL(`${new URL(origin).origin}/`);
  }

  spawnSiblingWindow(args: readonly string[], extraEnv?: Readonly<Record<string, string>>): void {
    const executable = this.deps.resolveLaunchExecutable();
    const env = filterGuiChildEnv(this.deps.env ?? process.env, this.platform);
    if (extraEnv !== undefined) {
      Object.assign(env, extraEnv);
    }
    const cwd = resolveChildWorkingDir(
      this.deps.currentExe ?? process.execPath,
      this.deps.currentDir ?? process.cwd(),
      executable,
      this.platform,
    );
    const spawnFn =
      this.deps.spawnSibling ??
      ((command, spawnArgs, opts) => spawn(command, [...spawnArgs], opts));
    const child = spawnFn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref?.();
  }

  openSpaceWindow(homePath: string): void {
    this.spawnSiblingWindow(['--home', homePath]);
  }

  openRemoteSpaceWindow(sourceHomePath: string, connectionId: string): void {
    this.spawnSiblingWindow(['--remote-connection', connectionId], {
      KIKI_HOME: sourceHomePath,
    });
  }

  openModeWindow(homePath: string, presetId: string): void {
    this.spawnSiblingWindow(['--home', homePath, '--preset', presetId]);
  }
}
