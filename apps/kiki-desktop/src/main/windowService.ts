import { spawn, type SpawnOptions } from 'node:child_process';
import { KIKI_APP_ORIGIN } from '#/main/appProtocol';
import { validateExternalUrl } from '#/main/fileAndClipboardService';
import { filterGuiChildEnv, resolveChildWorkingDir } from '#/main/releaseRedirect';
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
  getURL?(): string;
  setZoomFactor(factor: number): void;
  close(): void;
  destroy?(): void;
}

export interface WindowServiceDeps {
  readonly platform?: NodeJS.Platform;
  readonly windowMode: DesktopWindowMode;
  readonly spaceWindowMode: SpaceWindowMode;
  readonly startWindowless: boolean;
  readonly getCloseToTray: () => boolean;
  readonly isTrayActive: () => boolean;
  readonly createBrowserWindow: (initialUrl: string) => Promise<ManagedWindowLike>;
  readonly rendererOrigin?: string;
  readonly getDaemonOrigin: () => string | null;
  readonly ensureDaemonOrigin: () => Promise<string>;
  readonly detachDesktop: () => void;
  readonly releaseAppQuit: () => void;
  readonly setDockVisible?: (visible: boolean) => void;
  readonly setNativeTheme?: (theme: 'light' | 'dark' | 'system') => void;
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

export function isAllowedRendererNavigation(targetUrl: string, daemonOrigin: string | null): boolean {
  if (targetUrl.startsWith('data:text/html')) return true;
  const parsedTarget = URL.parse(targetUrl);
  if (parsedTarget === null) return false;
  if (parsedTarget.protocol.toLowerCase() === 'kiki-app:' && parsedTarget.hostname.toLowerCase() === 'localhost') {
    return true;
  }
  if (daemonOrigin === null) return false;
  const parsedOrigin = URL.parse(daemonOrigin);
  if (parsedOrigin === null) return false;
  return parsedTarget.origin === parsedOrigin.origin;
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
  private readonly rendererOrigin: string;
  private mainWindow: ManagedWindowLike | null = null;
  private creatingWindow: Promise<ManagedWindowLike> | null = null;
  private quitting = false;
  private closingKeepTray = false;

  constructor(private readonly deps: WindowServiceDeps) {
    this.platform = deps.platform ?? process.platform;
    this.rendererOrigin = deps.rendererOrigin ?? KIKI_APP_ORIGIN;
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

  private resolveInitialWindowUrl(): string {
    if (this.deps.rendererOrigin !== undefined) {
      return this.deps.rendererOrigin.endsWith('/')
        ? this.deps.rendererOrigin
        : `${this.deps.rendererOrigin}/`;
    }
    const legacyOrigin = this.deps.getDaemonOrigin();
    if (legacyOrigin !== null) {
      return legacyOrigin;
    }
    return `${this.rendererOrigin}/`;
  }

  async showMainWindow(): Promise<ManagedWindowLike | null> {
    if (this.quitting) return null;
    if (this.platform === 'darwin') {
      this.deps.setDockVisible?.(true);
    }
    let win = this.currentWindow;
    if (win === null) {
      if (this.creatingWindow === null) {
        const initialUrl = this.resolveInitialWindowUrl();
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
    const parsed = URL.parse(origin);
    if (
      parsed === null ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'kiki-app:') ||
      (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
    ) {
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

  destroyMainWindowKeepTray(): void {
    const win = this.currentWindow;
    if (win === null) return;
    if (!this.deps.isTrayActive()) {
      this.hideMainWindow();
      return;
    }
    this.closingKeepTray = true;
    try {
      if (typeof win.destroy === 'function') {
        win.destroy();
      } else {
        win.close();
      }
      this.mainWindow = null;
    } finally {
      this.closingKeepTray = false;
    }
    if (this.platform === 'darwin') {
      this.deps.setDockVisible?.(false);
    }
  }

  onWindowClose(event: WindowCloseEventLike): void {
    if (this.quitting || this.closingKeepTray) return;
    if (this.deps.getCloseToTray() && this.deps.isTrayActive()) {
      event.preventDefault();
      this.hideMainWindow();
      return;
    }
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

  setTheme(theme: 'light' | 'dark' | 'system'): void {
    this.deps.setNativeTheme?.(theme);
  }

  setZoom(factor: number): boolean {
    const win = this.currentWindow;
    if (win === null || !Number.isFinite(factor) || factor <= 0) return false;
    win.setZoomFactor(factor);
    return true;
  }

  async reloadForSwitchedSpace(): Promise<void> {
    await this.deps.ensureDaemonOrigin();
    const hadWindow = this.currentWindow !== null;
    const win = await this.showMainWindow();
    if (win === null) return;
    if (!hadWindow) return;

    const currentUrl = win.getURL?.();
    const parsedCurrent = currentUrl !== undefined ? URL.parse(currentUrl) : null;
    if (parsedCurrent !== null && (parsedCurrent.protocol === 'kiki-app:' || parsedCurrent.protocol === 'http:')) {
      win.reload();
      return;
    }
    await win.loadURL(this.resolveInitialWindowUrl());
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
