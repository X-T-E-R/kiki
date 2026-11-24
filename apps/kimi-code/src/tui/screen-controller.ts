/**
 * App-owned live screen-mode controller (`main` <-> `alt`), transient PageUp
 * transcript reader, and modal full-screen takeover coordinator.
 *
 * Exposes a stable `ui: TUI` Proxy (retaining prototype/`instanceof` and
 * dynamic method re-binding across renderer swaps, adapted from pi-mono MIT
 * `tui-renderer.ts`) while owning external listener disposers and DEC 1004
 * focus-reporting independence across live transitions.
 */

import chalk from 'chalk';
import {
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  type Component,
  type TUI,
  type Terminal,
  type TerminalColorScheme,
  type TuiInputListener,
  type TuiMainScreenRenderState,
} from '@kiki/pi-tui';

import { clipboard } from '#/utils/clipboard/clipboard-native';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { openUrl } from '#/utils/open-url';

import type { ScreenMode } from './config';
import { currentTheme } from './theme';
import { beginScreenTakeover, endScreenTakeover, type ScreenTakeover } from './utils/screen-takeover';

export interface ScreenLayoutContainers {
  readonly breadcrumbContainer: Component;
  readonly transcriptContainer: Component;
  readonly activityContainer: Component;
  readonly todoPanelContainer: Component;
  readonly queueContainer: Component;
  readonly btwPanelContainer: Component;
  readonly editorContainer: Component;
}

export interface ScreenSwitchOptions {
  /** Enter alt-screen as a transient reader without mutating persisted screenMode. */
  readonly transient?: boolean;
  /** After switching to alt, scroll up by this many viewport pages. */
  readonly scrollUpPages?: number;
  /** Explicit mouse capture override for alt-screen (defaults to saved preference ?? true). */
  readonly mouseOverride?: boolean;
}

export interface ScreenSwitchResult {
  readonly switched: boolean;
  readonly mode: ScreenMode;
  readonly effectiveMouse: boolean;
  readonly reason?: string;
}

interface TakeoverFrame {
  readonly takeover: ScreenTakeover;
  readonly previousFocus: Component | null;
  readonly onRestore?: () => void;
}

export interface ScreenControllerOptions {
  readonly terminal: Terminal;
  readonly initialMode: ScreenMode;
  readonly savedMousePreference: boolean | undefined;
  readonly containers: ScreenLayoutContainers;
  readonly onDockChanged?: (dock: VStack | undefined) => void;
}

export class ScreenController {
  private readonly terminal: Terminal;
  private readonly containers: ScreenLayoutContainers;
  private readonly onDockChanged?: (dock: VStack | undefined) => void;
  private footerComponent: Component | undefined;
  private mode: ScreenMode;
  private savedMousePreference: boolean | undefined;
  private transientReader = false;
  private takeoverEnteredAlt = false;
  private started = false;
  private switching: Promise<ScreenSwitchResult> | null = null;
  private mainRenderState: TuiMainScreenRenderState | undefined;
  private currentRenderer: TuiMainScreen | TuiAltScreen;
  private dockContainer: VStack | undefined;
  private readonly externalInputListeners = new Set<TuiInputListener>();
  private readonly externalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
  private readonly takeoverStack: TakeoverFrame[] = [];
  private canSwitchGuard: (() => string | undefined) | undefined;
  private onAllTakeoversClosed: (() => void) | undefined;
  private onClipboardStatus: ((message: string, tone?: 'normal' | 'error') => void) | undefined;
  private onTransientReaderExited: ((result: ScreenSwitchResult) => void) | undefined;

  readonly ui: TUI;

  constructor(options: ScreenControllerOptions) {
    this.terminal = options.terminal;
    this.containers = options.containers;
    this.onDockChanged = options.onDockChanged;
    this.mode = options.initialMode;
    this.savedMousePreference = options.savedMousePreference;

    this.ui = this.createProxy();
    this.currentRenderer = this.createRenderer(this.mode, this.getEffectiveMouse());
    this.mountModeLayout(this.mode, this.currentRenderer);
  }

  setCanSwitchGuard(guard: (() => string | undefined) | undefined): void {
    this.canSwitchGuard = guard;
  }

  setOnAllTakeoversClosed(listener: (() => void) | undefined): void {
    this.onAllTakeoversClosed = listener;
  }

  setOnClipboardStatus(listener: ((message: string, tone?: 'normal' | 'error') => void) | undefined): void {
    this.onClipboardStatus = listener;
  }

  setOnTransientReaderExited(listener: ((result: ScreenSwitchResult) => void) | undefined): void {
    this.onTransientReaderExited = listener;
  }

  /** Attach or replace the footer wrapper once constructed; kept across mode switches. */
  mountFooter(footer: Component): void {
    this.footerComponent = footer;
    if (this.mode === 'alt' && this.dockContainer !== undefined) {
      this.dockContainer.removeChild(footer);
      this.dockContainer.addChild(footer, { shrink: 0, minSize: 1 });
    } else if (this.mode === 'main') {
      this.currentRenderer.removeChild(footer);
      this.currentRenderer.addChild(footer);
    }
  }

  getMode(): ScreenMode {
    return this.mode;
  }

  getDockContainer(): VStack | undefined {
    return this.dockContainer;
  }

  getSavedMousePreference(): boolean | undefined {
    return this.savedMousePreference;
  }

  getEffectiveMouse(): boolean {
    return this.mode === 'alt' && (this.savedMousePreference ?? true);
  }

  setSavedMousePreference(enabled: boolean): boolean {
    this.savedMousePreference = enabled;
    const effective = this.getEffectiveMouse();
    if (this.currentRenderer instanceof TuiAltScreen) {
      this.currentRenderer.setMouseReporting(effective);
    } else {
      this.currentRenderer.setMouseReporting(false);
    }
    return effective;
  }

  isTransientReaderActive(): boolean {
    return this.transientReader;
  }

  isTakeoverActive(): boolean {
    return this.takeoverStack.length > 0;
  }

  markStarted(started: boolean): void {
    this.started = started;
  }

  /** Open the built-in alt-screen transcript search; enters transient alt reader when in main mode. */
  async openTranscriptSearch(): Promise<boolean> {
    if (this.mode === 'main') {
      const result = await this.enterTransientReader(0);
      if (!result.switched) return false;
    }
    if (this.currentRenderer instanceof TuiAltScreen) {
      this.currentRenderer.openTranscriptSearch();
      return true;
    }
    return false;
  }

  isTranscriptSearchOpen(): boolean {
    return (
      this.currentRenderer instanceof TuiAltScreen &&
      this.currentRenderer.isTranscriptSearchOpen()
    );
  }

  closeTranscriptSearch(): void {
    if (this.currentRenderer instanceof TuiAltScreen) {
      this.currentRenderer.closeTranscriptSearch();
    }
  }

  /**
   * Enter a transient alt-screen viewport reader from `main` mode (e.g. PageUp
   * or `/find` on main) without mutating the saved `screenMode` preference.
   */
  async enterTransientReader(scrollUpPages = 1): Promise<ScreenSwitchResult> {
    if (this.mode === 'alt') {
      if (scrollUpPages > 0 && this.currentRenderer instanceof TuiAltScreen) {
        const page = Math.max(1, this.terminal.rows - 6);
        this.currentRenderer.scrollBy(-page * scrollUpPages);
      }
      return {
        switched: false,
        mode: this.mode,
        effectiveMouse: this.getEffectiveMouse(),
      };
    }
    return this.switchScreen('alt', { transient: true, scrollUpPages });
  }

  /** Exit the transient alt-screen reader back to `main`, preserving exact draft & focus. */
  async exitTransientReader(): Promise<ScreenSwitchResult> {
    if (!this.transientReader) {
      return {
        switched: false,
        mode: this.mode,
        effectiveMouse: this.getEffectiveMouse(),
      };
    }
    if (this.currentRenderer instanceof TuiAltScreen && this.currentRenderer.isTranscriptSearchOpen()) {
      this.currentRenderer.closeTranscriptSearch();
    }
    const result = await this.switchScreen('main', { transient: false });
    if (result.switched) {
      this.transientReader = false;
    }
    return result;
  }

  /** Scroll the transcript viewport to a specific rendered line offset; enters transient alt reader from main. */
  async scrollToTranscriptLine(lineOffset: number): Promise<boolean> {
    if (this.mode === 'main') {
      const entered = await this.enterTransientReader(0);
      if (!entered.switched) return false;
    }
    if (!(this.currentRenderer instanceof TuiAltScreen)) return false;
    if (this.started) {
      this.currentRenderer.renderNow(true);
    }
    this.currentRenderer.scrollTo(Math.max(0, lineOffset - 2));
    if (this.started) {
      this.currentRenderer.renderNow();
    }
    return true;
  }

  /**
   * Mount a full-screen modal takeover (e.g. TasksBrowserApp, TaskOutputViewer,
   * ApprovalPreviewViewer). Supports nesting, preserves native main scrollback
   * (by hosting takeovers on a temporary alt screen instead of issuing CSI 3J on
   * main), and guarantees deferred interactions are notified once the outermost
   * takeover closes.
   */
  beginTakeover(viewer: Component, onRestore?: () => void): () => void {
    const previousFocus = this.currentRenderer.getFocusedComponent();
    if (this.takeoverStack.length === 0 && this.mode === 'main') {
      const swapped = this.swapRendererSync('alt', { transient: false });
      if (swapped.switched) {
        this.takeoverEnteredAlt = true;
      }
    }
    const takeover = beginScreenTakeover(this.currentRenderer, viewer);
    const frame: TakeoverFrame = { takeover, previousFocus, onRestore };
    this.takeoverStack.push(frame);
    this.currentRenderer.setFocus(viewer);
    this.currentRenderer.requestRender(true);

    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const idx = this.takeoverStack.lastIndexOf(frame);
      if (idx >= 0) {
        this.takeoverStack.splice(idx, 1);
      }
      endScreenTakeover(this.currentRenderer, frame.takeover);
      if (this.takeoverStack.length === 0 && this.takeoverEnteredAlt) {
        this.takeoverEnteredAlt = false;
        this.swapRendererSync('main', { transient: false });
        if (frame.previousFocus !== null) {
          this.currentRenderer.setFocus(frame.previousFocus);
        }
        // Incremental render only — never pass force=true on main so native scrollback is preserved.
        this.currentRenderer.requestRender();
      } else {
        if (frame.previousFocus !== null) {
          this.currentRenderer.setFocus(frame.previousFocus);
        }
        this.currentRenderer.requestRender(true);
      }
      frame.onRestore?.();
      if (this.takeoverStack.length === 0) {
        this.onAllTakeoversClosed?.();
      }
    };
  }

  /** Serialized live screen-mode transition without restarting or reconnecting the daemon. */
  async switchScreen(
    target: ScreenMode,
    options: ScreenSwitchOptions = {},
  ): Promise<ScreenSwitchResult> {
    const run = async (): Promise<ScreenSwitchResult> => {
      if (options.mouseOverride !== undefined) {
        this.savedMousePreference = options.mouseOverride;
      }
      if (this.mode === target) {
        if (target === 'alt' && options.transient !== true) {
          this.transientReader = false;
        }
        const effectiveMouse = this.getEffectiveMouse();
        if (this.currentRenderer instanceof TuiAltScreen) {
          this.currentRenderer.setMouseReporting(effectiveMouse);
        }
        return {
          switched: false,
          mode: this.mode,
          effectiveMouse,
        };
      }

      if (this.takeoverStack.length > 0) {
        return {
          switched: false,
          mode: this.mode,
          effectiveMouse: this.getEffectiveMouse(),
          reason: 'Close the active full-screen viewer before switching screen mode.',
        };
      }
      if (this.currentRenderer.hasOverlay() && !this.isTranscriptSearchOpen()) {
        return {
          switched: false,
          mode: this.mode,
          effectiveMouse: this.getEffectiveMouse(),
          reason: 'Close the active overlay before switching screen mode.',
        };
      }
      const guardReason = this.canSwitchGuard?.();
      if (guardReason !== undefined) {
        return {
          switched: false,
          mode: this.mode,
          effectiveMouse: this.getEffectiveMouse(),
          reason: guardReason,
        };
      }

      return this.swapRendererSync(target, options);
    };

    const nextTask = (this.switching ?? Promise.resolve<ScreenSwitchResult>({
      switched: false,
      mode: this.mode,
      effectiveMouse: this.getEffectiveMouse(),
    })).then(run, run);
    this.switching = nextTask;
    try {
      return await nextTask;
    } finally {
      if (this.switching === nextTask) {
        this.switching = null;
      }
    }
  }

  private swapRendererSync(
    target: ScreenMode,
    options: ScreenSwitchOptions,
  ): ScreenSwitchResult {
    const previousRenderer = this.currentRenderer;
    const previousMode = this.mode;
    const previousFocus = previousRenderer.getFocusedComponent();
    const hardwareCursor = previousRenderer.getShowHardwareCursor();
    const clearOnShrink = previousRenderer.getClearOnShrink();
    const onDebug = previousRenderer.onDebug;

    if (previousRenderer instanceof TuiMainScreen) {
      this.mainRenderState = previousRenderer.captureRenderState();
    }

    const wasStarted = this.started;
    try {
      if (wasStarted) {
        previousRenderer.stop({ preserveScreen: true });
      }
      if (previousRenderer instanceof TuiMainScreen) {
        previousRenderer.clear();
      } else {
        previousRenderer.setLayoutRoot(undefined);
      }

      const nextEffectiveMouse = target === 'alt' && (this.savedMousePreference ?? true);
      const nextRenderer = this.createRenderer(target, nextEffectiveMouse);
      nextRenderer.setShowHardwareCursor(hardwareCursor);
      nextRenderer.setClearOnShrink(clearOnShrink);
      nextRenderer.onDebug = onDebug;

      this.mountModeLayout(target, nextRenderer);

      for (const listener of this.externalInputListeners) {
        nextRenderer.addInputListener(listener);
      }
      for (const listener of this.externalColorSchemeListeners) {
        nextRenderer.onTerminalColorSchemeChange(listener);
      }

      this.currentRenderer = nextRenderer;
      this.mode = target;
      this.transientReader = target === 'alt' && options.transient === true;

      if (target === 'main' && nextRenderer instanceof TuiMainScreen && this.mainRenderState !== undefined) {
        nextRenderer.restoreRenderState(this.mainRenderState);
      }
      if (previousFocus !== null) {
        nextRenderer.setFocus(previousFocus);
      }
      if (wasStarted) {
        nextRenderer.start();
      }
      if (
        target === 'alt' &&
        nextRenderer instanceof TuiAltScreen &&
        options.scrollUpPages !== undefined &&
        options.scrollUpPages > 0
      ) {
        // Measure the real layout & content height before scrolling so the very
        // first PageUp immediately moves up instead of clamping against 0.
        if (wasStarted) {
          nextRenderer.renderNow(true);
        }
        const page = Math.max(1, this.terminal.rows - 6);
        nextRenderer.scrollBy(-page * options.scrollUpPages);
        if (wasStarted) {
          nextRenderer.renderNow();
        }
      }
      return {
        switched: true,
        mode: this.mode,
        effectiveMouse: this.getEffectiveMouse(),
      };
    } catch (error) {
      // Restore previous working renderer on activation failure.
      this.currentRenderer = previousRenderer;
      this.mode = previousMode;
      this.mountModeLayout(previousMode, previousRenderer);
      if (previousFocus !== null) {
        previousRenderer.setFocus(previousFocus);
      }
      if (wasStarted) {
        previousRenderer.start();
      }
      return {
        switched: false,
        mode: this.mode,
        effectiveMouse: this.getEffectiveMouse(),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private createRenderer(mode: ScreenMode, effectiveMouse: boolean): TuiMainScreen | TuiAltScreen {
    if (mode === 'alt') {
      return new TuiAltScreen(this.terminal, undefined, undefined, {
        mouse: effectiveMouse,
        // App-level terminal focus tracking owns DEC 1004 across main/alt switches.
        focusReporting: false,
        wheelScrollLines: 'auto',
        searchMatchStyle: (text) =>
          chalk.bgHex(currentTheme.palette.warning).hex(currentTheme.palette.textStrong)(text),
        searchCurrentMatchStyle: (text) =>
          chalk.bgHex(currentTheme.palette.primary).hex(currentTheme.palette.textStrong).bold(text),
        scrollToEndIndicator: () =>
          chalk.bgHex(currentTheme.palette.primary).hex(currentTheme.palette.text).bold(
            ' ↓ Jump to latest · End ',
          ),
        copyOnSelect: true,
        copySelection: async (text) => {
          const outcome = await copyTextToClipboard(text);
          if (outcome === 'native') {
            this.onClipboardStatus?.('Copied selection to clipboard.');
            return 'Copied';
          }
          if (outcome === 'osc52') {
            this.onClipboardStatus?.('Sent selection to terminal clipboard (OSC 52).');
            return 'Sent to terminal clipboard (OSC 52)';
          }
          this.onClipboardStatus?.('Clipboard access is unavailable.', 'error');
          return false;
        },
        openUrl,
        onViewportBottomKey: () => {
          if (!this.transientReader || this.currentRenderer.hasOverlay() || this.takeoverStack.length > 0) {
            return false;
          }
          void this.exitTransientReader().then((res) => {
            if (res.switched) this.onTransientReaderExited?.(res);
          });
          return true;
        },
        onRightClickPaste: () => {
          const target = this.ui.getFocusedComponent();
          if (!target?.handleInput || clipboard?.getText === undefined) return;
          void clipboard
            .getText()
            .then((text) => {
              if (!text || this.ui.getFocusedComponent() !== target) return;
              target.handleInput?.(`\x1b[200~${text}\x1b[201~`);
              this.ui.requestRender();
            })
            .catch(() => {});
        },
      });
    }
    return new TuiMainScreen(this.terminal, false, undefined, {
      mouse: false,
    });
  }

  private mountModeLayout(mode: ScreenMode, renderer: TuiMainScreen | TuiAltScreen): void {
    if (mode === 'alt' && renderer instanceof TuiAltScreen) {
      const scrollView = new ScrollView(this.containers.transcriptContainer, {
        follow: 'end',
        primary: true,
        overscroll: 'chain',
        scrollbar: 'auto',
      });
      const dock = new VStack();
      dock.addChild(this.containers.activityContainer, { shrink: 1, minSize: 0 });
      dock.addChild(this.containers.todoPanelContainer, { shrink: 1, minSize: 0 });
      dock.addChild(this.containers.queueContainer, { shrink: 1, minSize: 0 });
      dock.addChild(this.containers.btwPanelContainer, { shrink: 1, minSize: 0 });
      dock.addChild(this.containers.editorContainer, { shrink: 1, minSize: 3 });
      if (this.footerComponent !== undefined) {
        dock.addChild(this.footerComponent, { shrink: 0, minSize: 1 });
      }
      const root = new VStack();
      root.addChild(this.containers.breadcrumbContainer, { basis: 'auto', grow: 0, shrink: 0, minSize: 0 });
      root.addChild(scrollView, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
      root.addChild(dock, { basis: 'auto', grow: 0, shrink: 1, minSize: 1 });
      renderer.setLayoutRoot(root);
      this.dockContainer = dock;
      this.onDockChanged?.(dock);
      return;
    }

    this.dockContainer = undefined;
    this.onDockChanged?.(undefined);
    renderer.clear();
    renderer.addChild(this.containers.breadcrumbContainer);
    renderer.addChild(this.containers.transcriptContainer);
    renderer.addChild(this.containers.activityContainer);
    renderer.addChild(this.containers.todoPanelContainer);
    renderer.addChild(this.containers.queueContainer);
    renderer.addChild(this.containers.btwPanelContainer);
    renderer.addChild(this.containers.editorContainer);
    if (this.footerComponent !== undefined) {
      renderer.addChild(this.footerComponent);
    }
  }

  private createProxy(): TUI {
    const controller = this;
    const target = {} as TUI;
    return new Proxy(target, {
      get(proxyTarget, prop, receiver) {
        if (Object.prototype.hasOwnProperty.call(proxyTarget, prop)) {
          return Reflect.get(proxyTarget, prop, receiver);
        }
        if (prop === 'addInputListener') {
          return (listener: TuiInputListener): (() => void) => {
            controller.externalInputListeners.add(listener);
            controller.currentRenderer.addInputListener(listener);
            return () => {
              controller.externalInputListeners.delete(listener);
              controller.currentRenderer.removeInputListener(listener);
            };
          };
        }
        if (prop === 'removeInputListener') {
          return (listener: TuiInputListener): void => {
            controller.externalInputListeners.delete(listener);
            controller.currentRenderer.removeInputListener(listener);
          };
        }
        if (prop === 'onTerminalColorSchemeChange') {
          return (listener: (scheme: TerminalColorScheme) => void): (() => void) => {
            controller.externalColorSchemeListeners.add(listener);
            let activeDispose = controller.currentRenderer.onTerminalColorSchemeChange(listener);
            return () => {
              controller.externalColorSchemeListeners.delete(listener);
              activeDispose();
              // No-op if renderer swapped; externalColorSchemeListeners no longer has it.
              activeDispose = () => {};
            };
          };
        }
        if (prop === 'start') {
          return (): void => {
            controller.started = true;
            controller.currentRenderer.start();
          };
        }
        if (prop === 'stop') {
          return (options?: Parameters<TUI['stop']>[0]): void => {
            controller.started = false;
            controller.currentRenderer.stop(options);
          };
        }
        const active = controller.currentRenderer as unknown as Record<PropertyKey, unknown>;
        const value = Reflect.get(active, prop, active);
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            const latest = controller.currentRenderer as unknown as Record<PropertyKey, unknown>;
            const fn = Reflect.get(latest, prop, latest) as (...a: unknown[]) => unknown;
            return fn.apply(latest, args);
          };
        }
        return value;
      },
      set(proxyTarget, prop, value) {
        if (Object.prototype.hasOwnProperty.call(proxyTarget, prop)) {
          return Reflect.set(proxyTarget, prop, value);
        }
        return Reflect.set(controller.currentRenderer as unknown as object, prop, value);
      },
      defineProperty(proxyTarget, prop, descriptor) {
        return Reflect.defineProperty(proxyTarget, prop, descriptor);
      },
      deleteProperty(proxyTarget, prop) {
        if (Object.prototype.hasOwnProperty.call(proxyTarget, prop)) {
          return Reflect.deleteProperty(proxyTarget, prop);
        }
        return Reflect.deleteProperty(controller.currentRenderer as unknown as object, prop);
      },
      getOwnPropertyDescriptor(proxyTarget, prop) {
        return (
          Reflect.getOwnPropertyDescriptor(proxyTarget, prop) ??
          Reflect.getOwnPropertyDescriptor(controller.currentRenderer as unknown as object, prop)
        );
      },
      has(proxyTarget, prop) {
        return (
          Reflect.has(proxyTarget, prop) ||
          Reflect.has(controller.currentRenderer as unknown as object, prop)
        );
      },
      getPrototypeOf() {
        return Object.getPrototypeOf(controller.currentRenderer);
      },
    });
  }
}
