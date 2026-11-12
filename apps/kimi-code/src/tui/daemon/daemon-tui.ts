import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { Container, Spacer, Text, TuiAltScreen, type Component, type Terminal } from '@kiki/pi-tui';
import { sameWorkDir, type PermissionMode } from '@kiki/node-sdk';
import { ErrorCode, type ManagedUsageResult, type MessageContent, type PromptStatus, type UpdateSessionProfileRequest } from '@kiki/protocol';

import type { SessionViewSignal } from '@kiki/klient/session-view';
import { API_CODES, ApiError } from '@kiki/session-core/transport';
import { sortThinkingEffortsForDisplay } from '@kiki/session-core/settings/thinkingEffort';
import { latestTurnId } from '@kiki/session-core/session';
import { SendNowError, SessionController } from '@kiki/session-core/session/sessionController';
import { newSteerPromptId } from '@kiki/session-core/session/transcript/steer';
import type {
  ApprovalBlock,
  Block,
  QuestionBlock,
  SessionViewState,
} from '@kiki/session-core/session/transcript/types';

import { ActivityLineComponent, type ActivityLineParts } from '#/tui/components/chrome/activity-line';
import type { FooterAction } from '#/tui/components/chrome/footer';
import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from '#/tui/components/dialogs/approval-panel';
import { ApprovalPreviewViewer } from '#/tui/components/dialogs/approval-preview';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { PermissionSelectorComponent } from '#/tui/components/dialogs/permission-selector';
import { HelpPanelComponent } from '#/tui/components/dialogs/help-panel';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from '#/tui/components/dialogs/session-picker';
import { SettingsDialogComponent } from '#/tui/components/dialogs/settings-dialog';
import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';
import { GoalStatusMessageComponent } from '#/tui/components/messages/goal-panel';
import {
  buildUsageReportLines,
  UsagePanelComponent,
  type ManagedUsageReport,
} from '#/tui/components/messages/usage-panel';
import { saveTuiConfig, type TuiConfig } from '#/tui/config';
import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  ESC_INTERRUPT_HINT,
  EXIT_CONFIRM_WINDOW_MS,
  INTERACTION_ARM_AFTER_MS,
  INTERRUPT_CONFIRM_WINDOW_MS,
} from '#/tui/constant/kimi-tui';
import {
  MEDIA_SETTLEMENT_RETRY_BASE_MS,
  MEDIA_SETTLEMENT_RETRY_MAX_MS,
  MEDIA_STAGING_TTL_SECONDS,
} from '#/tui/constant/media';
import {
  ACTIVITY_TICK_INTERVAL_MS,
  CHROME_GUTTER,
} from '#/tui/constant/rendering';
import { adaptApprovalRequest } from '#/tui/interactions/approval-adapter';
import {
  adaptQuestionRequest,
  adaptQuestionResponse,
} from '#/tui/interactions/question-adapter';
import type { ApprovalPanelData, QuestionPanelResponse } from '#/tui/interactions/types';
import { currentTheme, getColorPalette } from '#/tui/theme';
import { createTUIState, type TUIState } from '#/tui/tui-state';
import { parseGoalCommand } from '#/tui/commands/goal-parse';
import type { AppState, KimiTUIOptions } from '#/tui/types';
import { formatErrorMessage } from '#/tui/utils/event-payload';
import { setMarkdownRenderLatex } from '#/tui/utils/markdown-options';
import { installTerminalFocusTracking } from '#/tui/utils/terminal-focus';
import { notifyTerminalOnce } from '#/tui/utils/terminal-notification';
import { buildExportMarkdown } from '#/tui/utils/export-markdown';
import {
  ImageAttachmentStore,
  type MediaAttachment,
} from '#/tui/utils/image-attachment-store';
import { extractInlineSkillActivations } from '#/tui/utils/inline-skill-tokens';
import { readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';
import { appendInputHistory, loadInputHistory } from '#/utils/history/input-history';
import { parseImageMeta } from '#/utils/image/image-mime';
import { openUrl } from '#/utils/open-url';
import { getInputHistoryFile } from '#/utils/paths';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';
import { parsePluginInstallArgs } from '#/tui/utils/plugin-install-args';
import { editInExternalEditor, resolveEditorCommand } from '#/utils/process/external-editor';
import { detectFdPath } from '#/utils/process/fd-detect';

import { projectAttachmentSettlement } from './attachment-settlement';
import { executeWebCommand } from './web-command';
import {
  prepareDaemonPrompt,
  type DaemonFileAttachment,
  type PreparedDaemonPrompt,
} from './attachments';
import { DaemonClient, type DaemonPersonaSummary } from './client';
import {
  DAEMON_HELP_DISCOVERY_NOTE,
  daemonAutocompleteCommands,
  daemonHelpCommands,
  daemonSkillCommands,
  parseDaemonSlashInput,
  resolveDaemonCommand,
  validateDaemonCommandArgs,
  type DaemonSkillCommand,
} from './commands';
import { resolveDaemonHome, type DaemonConnection } from './discovery';
import { DaemonProgramStatus } from './program-status';
import { DaemonTranscriptRenderer, TranscriptNoteComponent } from './transcript-renderer';
import {
  activityLineText,
  formatBusyActivityLine,
  formatWaitingActivityLine,
  resolveStatusNoticePolicy,
  TurnActivityTracker,
  type ShowStatusOptions,
  type StatusNotice,
} from './activity-status-helper';

export interface DaemonTUIStartupInput {
  readonly cliOptions: {
    readonly session?: string;
    readonly continue: boolean;
    readonly ephemeral?: boolean;
    readonly yolo: boolean;
    readonly auto: boolean;
    readonly plan: boolean;
    readonly model?: string;
    readonly thinking?: string;
    readonly persona?: string;
    readonly agentFiles: readonly string[];
    readonly skillsDirs: readonly string[];
  };
  readonly agentProfile?: string;
  readonly additionalDirs?: readonly string[];
  readonly tuiConfig: TuiConfig;
  readonly tuiConfigPath?: string;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
}

type SessionSummary = Awaited<ReturnType<DaemonClient['listSessions']>>['items'][number];

type ActivityKind = 'idle' | 'busy' | 'waiting' | 'retry' | 'resyncing' | 'resyncFailed';

interface AttachmentSettlementLease {
  readonly sessionId: string;
  readonly promptId?: string;
  readonly turnId?: string;
  readonly promptState?: PromptStatus;
  readonly uploadIds: Set<string>;
  readonly deadlineAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  deleteRetryTimer: ReturnType<typeof setTimeout> | undefined;
  deleteFailures: number;
  settled: boolean;
  releasing: boolean;
}

interface AttachmentControllerLease {
  readonly dispose: () => void;
  readonly deadlineTimer: ReturnType<typeof setTimeout>;
}

interface InvalidUploadCleanup {
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  inFlight: Promise<unknown> | undefined;
}

export class DaemonTUI {
  readonly state: TUIState;
  public onExit?: (exitCode?: number) => Promise<void>;

  private readonly client: DaemonClient;
  private readonly programStatus: DaemonProgramStatus;
  private readonly renderer: DaemonTranscriptRenderer;
  private readonly startup: DaemonTUIStartupInput;
  private currentTuiConfig: TuiConfig;
  private controller: SessionController | undefined;
  private mainControllerDispose: (() => void) | undefined;
  private focusedControllerDispose: (() => void) | undefined;
  private activeInteractionId: string | undefined;
  /**
   * An approval or question arrived while the user had their own dialog open
   * (or such a dialog was mounted over it); it is shown once that dialog closes.
   */
  private interactionDeferred = false;
  private activeSessionPicker: SessionPickerComponent | undefined;
  private readonly skillCommands = new Map<string, DaemonSkillCommand>();
  private readonly agentProfileCommands = new Map<string, string>();
  private readonly imageAttachments = new ImageAttachmentStore();
  private readonly fileAttachments = new Map<number, DaemonFileAttachment>();
  private nextFileAttachmentId = 1;
  private focusedAgentId = 'main';
  private pendingConfirm:
    | { readonly kind: 'ctrl-c' | 'ctrl-d' | 'escape' | 'draft-cleared'; readonly timer: ReturnType<typeof setTimeout> }
    | undefined;
  private startupOverridesPending = true;
  private todoExpanded = false;
  private sourceOverlayLeaseId: string | undefined;
  private sourceOverlayLeaseExpiresAt: number | undefined;
  private sourceOverlayHeartbeat: ReturnType<typeof setTimeout> | undefined;
  private sourceOverlaySessionId: string | undefined;
  private sourceOverlayReattachPending = false;
  private sourceOverlayHeartbeatFailures = 0;
  private readonly attachmentSettlementLeases = new Map<string, AttachmentSettlementLease>();
  private readonly attachmentControllerLeases = new Map<SessionController, AttachmentControllerLease>();
  private readonly attachmentRefreshes = new WeakMap<object, Promise<void>>();
  private readonly invalidUploadCleanups = new Map<string, InvalidUploadCleanup>();
  private readonly unconfirmedUploadIds = new Set<string>();
  private readonly sideControllers = new Set<SessionController>();
  private readonly temporarySessionIds = new Set<string>();
  private stopped = false;
  private disposal: Promise<void> | undefined;
  private exiting: Promise<void> | undefined;
  private sourceOverlayErrorActive = false;
  private activeStatusNotice: StatusNotice | undefined;
  private lastActivityKind: ActivityKind = 'idle';
  /** Whether the busy line was last drawn for a draft ("Esc twice") or an empty input. */
  private activityHasDraft = false;
  private activityTickTimer: ReturnType<typeof setInterval> | undefined;
  private readonly turnActivityTracker = new TurnActivityTracker();
  /**
   * Serializes input-history work (the startup load, then each submit) and
   * resolves to the last persisted entry, so ↑ order and the on-disk dedupe
   * stay correct even when the user submits before the load finishes.
   */
  private inputHistory: Promise<string | undefined> = Promise.resolve(undefined);
  /** Busy flag of the last rendered main view, to notify when a turn ends. */
  private wasBusy = false;
  private completedTurns = 0;
  private disposeFocusTracking: (() => void) | undefined;
  private authFlowTimer: ReturnType<typeof setTimeout> | undefined;
  /** fd binary for `@` mentions; null keeps the built-in directory scan. */
  private fdPath: string | null = null;
  /** Startup's session open/create; input submitted meanwhile waits for it. */
  private sessionReady: Promise<void> | undefined;
  private readonly transcriptBody = new Container();

  constructor(private readonly connection: DaemonConnection, startup: DaemonTUIStartupInput, terminal?: Terminal) {
    this.startup = startup;
    this.currentTuiConfig = { ...startup.tuiConfig };
    this.state = createTUIState(createOptions(startup), terminal);
    this.client = new DaemonClient(connection);
    this.programStatus = new DaemonProgramStatus(
      this.client,
      connection,
      (sequence) => this.state.terminal.write(sequence),
      () => this.state.terminalState.focused,
      (sessionId) => this.temporarySessionIds.has(sessionId) || this.startup.cliOptions.ephemeral === true,
    );
    this.state.ui.addInputListener((data) => this.programStatus.input(data));
    this.state.transcriptContainer.addChild(this.transcriptBody);
    this.renderer = new DaemonTranscriptRenderer(
      this.transcriptBody,
      this.state.ui,
      startup.workDir,
      {
        showThinking: startup.tuiConfig.showThinking !== false,
        showTimestamps: startup.tuiConfig.showTimestamps === true,
      },
    );
    this.buildLayout();
    this.installEditor();
    this.setupAutocomplete();
  }

  async start(): Promise<void> {
    this.inputHistory = this.loadInputHistory();
    this.state.ui.start();
    this.programStatus.start();
    // Focus reports let `[notifications] notification_condition = "unfocused"`
    // stay quiet while the user is looking at this terminal.
    this.disposeFocusTracking = installTerminalFocusTracking(this.state);
    // An installed fd makes `@` completion fast and .gitignore-aware; the
    // built-in scan stops at 2,000 entries. Probing runs `fd --version`, so do
    // it after the first frame. This only looks for an fd that is already
    // installed; it does not download one.
    setImmediate(() => {
      if (this.stopped) return;
      this.fdPath = detectFdPath();
      if (this.fdPath !== null) this.setupAutocomplete();
    });
    this.state.transcriptContainer.clear();
    this.state.transcriptContainer.addChild(new WelcomeComponent(this.state.appState, this.state.terminal.rows));
    this.state.transcriptContainer.addChild(this.transcriptBody);
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.state.todoPanelContainer.addChild(this.state.todoPanel);
    this.mountFooter();
    if (this.startup.startupNotice !== undefined) this.showStatus(this.startup.startupNotice);
    this.sessionReady = this.refreshAgentCommands().then(() => this.initializeSession());
    await this.sessionReady;
  }

  close(): Promise<void> {
    return this.dispose();
  }

  stop(exitCode = 0): Promise<void> {
    this.exiting ??= this.dispose().then(() => this.onExit?.(exitCode));
    return this.exiting;
  }

  getCurrentSessionId(): string {
    return this.controller?.sessionId ?? '';
  }

  hasSessionContent(): boolean {
    return (this.controller?.getState().blocks.length ?? 0) > 0;
  }

  clearProgramStatus(): Promise<void> {
    return this.programStatus.dispose();
  }

  private dispose(): Promise<void> {
    this.disposal ??= this.finishDispose();
    return this.disposal;
  }

  private async finishDispose(): Promise<void> {
    this.stopped = true;
    let failure: Error | undefined;
    const cleanup = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    };
    clearTimeout(this.authFlowTimer);
    this.authFlowTimer = undefined;
    await cleanup(() => this.clearProgramStatus());
    await cleanup(() => {
      this.clearPendingConfirm();
    });
    await cleanup(() => this.focusedControllerDispose?.());
    this.focusedControllerDispose = undefined;
    await cleanup(() => this.mainControllerDispose?.());
    this.mainControllerDispose = undefined;
    await cleanup(() => this.controller?.close());
    this.controller = undefined;
    await cleanup(() => {
      for (const lease of this.attachmentControllerLeases.values()) {
        lease.dispose();
        clearTimeout(lease.deadlineTimer);
      }
      this.attachmentControllerLeases.clear();
    });
    await cleanup(() => {
      for (const controller of this.sideControllers) controller.close();
      this.sideControllers.clear();
    });
    await cleanup(() => {
      this.renderer.dispose();
    });
    await cleanup(() => this.clearAttachments());
    await cleanup(() => this.releaseSettledAttachmentLeases());
    await cleanup(() => {
      this.clearAttachmentSettlementTimers();
    });
    await cleanup(() => this.disposeInvalidUploadCleanups());
    await cleanup(() => this.releaseExplicitSources());
    await cleanup(() => {
      this.clearSourceOverlayHeartbeat();
    });
    for (const sessionId of this.temporarySessionIds) {
      await cleanup(async () => { await this.client.endEphemeralSession(sessionId); });
    }
    this.temporarySessionIds.clear();
    await cleanup(() => this.client.close());
    await cleanup(() => {
      this.clearStatusNotice();
      this.clearActivityTickTimer();
      this.turnActivityTracker.reset();
    });
    await cleanup(() => {
      this.state.footer.dispose();
    });
    await cleanup(() => {
      this.disposeFocusTracking?.();
      this.disposeFocusTracking = undefined;
    });
    await cleanup(() => this.state.terminal.drainInput());
    await cleanup(() => {
      this.state.ui.stop();
    });
    if (failure !== undefined) throw failure;
  }

  private buildLayout(): void {
    if (this.state.ui instanceof TuiAltScreen) return;
    this.state.ui.clear();
    this.state.ui.addChild(this.state.transcriptContainer);
    this.state.ui.addChild(this.state.activityContainer);
    this.state.ui.addChild(this.state.todoPanelContainer);
    this.state.ui.addChild(this.state.editorContainer);
  }

  private mountFooter(): void {
    this.state.footer.setOnAction((action) => {
      this.handleFooterAction(action);
    });
    const wrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    wrap.addChild(this.state.footer);
    if (this.state.dockContainer !== undefined) {
      this.state.dockContainer.addChild(wrap, { shrink: 1, minSize: 1 });
    } else {
      this.state.ui.addChild(wrap);
    }
  }

  private handleFooterAction(action: FooterAction): void {
    // Do not interrupt a pending approval/question or user dialog with a footer click.
    if (this.activeInteractionId !== undefined) return;
    if (this.state.editorContainer.children[0] !== this.state.editor) {
      this.restoreEditor();
    }
    const run = (promise: Promise<void>): void => {
      void promise.catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
    };
    switch (action) {
      case 'permission':
        this.showPermissionPicker();
        return;
      case 'plan':
        run(this.applyPlanMode(!this.state.appState.planMode));
        return;
      case 'goal':
        run(this.handleGoalCommand(''));
        return;
      case 'model':
        run(this.showModelPicker());
        return;
      case 'effort':
        run(this.showThinkingPicker());
        return;
      case 'tasks':
        run(this.handleTasksCommand(''));
        return;
      case 'agents':
        run(this.showAgentRoster());
        return;
      case 'usage':
        run(this.showUsage());
        return;
      case 'settings':
        this.showSettingsDialog();
        return;
    }
  }

  private installEditor(): void {
    const editor = this.state.editor;
    editor.onSubmit = (text) => {
      if (editor.disableSubmit) {
        editor.setText(text);
        return;
      }
      this.clearPendingConfirm();
      const mode = editor.inputMode;
      const trimmed = text.trim();
      // When a turn is running and busy_submit is 'send_now' (the default),
      // plain Enter steers the active turn immediately (`sendPromptNow`).
      // Slash commands, shell commands (`!`), and active goals keep their normal paths.
      if (
        this.controller?.getState().busy === true &&
        this.controller.getState().goal?.status !== 'active' &&
        mode !== 'bash' &&
        trimmed !== '' &&
        !trimmed.startsWith('/') &&
        !trimmed.startsWith('!') &&
        (this.state.appState.busySubmit ?? 'send_now') === 'send_now'
      ) {
        void this.steerSubmittedText(text, mode).catch((error: unknown) => this.showSubmissionError(error));
        return;
      }
      this.recordInputHistory(text, mode);
      const submission = { accepted: false };
      void this.handleInput(text, submission).catch((error: unknown) => {
        // pi-tui clears the editor (and its undo stack) before onSubmit, so a
        // failed send would lose the draft. Put it back unless the daemon had
        // already accepted it — a later resync failure must not invite a
        // duplicate send — or the user has started typing something else.
        if (!submission.accepted && editor.getText() === '') {
          editor.setInputMode(mode);
          editor.setText(text);
        }
        this.showSubmissionError(error);
      });
    };
    editor.onChange = (text) => {
      // The busy line tells how to interrupt, which depends on the draft.
      if (this.lastActivityKind !== 'busy' || (text.length > 0) === this.activityHasDraft) return;
      if (this.controller !== undefined) this.renderActivityState(this.controller.getState());
    };
    editor.onCtrlC = () => {
      void this.handleInterrupt('ctrl-c');
    };
    editor.onCtrlD = () => {
      this.confirmExit('ctrl-d');
    };
    // Esc with the input focused, after CustomEditor has closed a completion
    // menu or left an empty shell mode: leave history browsing first; while a
    // turn runs, interrupt at once on an empty input, but with a draft only arm
    // the interrupt — that Esc was most likely meant for the input box (a vim
    // reflex, an IME cancel, a split arrow-key sequence). A second Esc within
    // the window interrupts and leaves the draft in place. Idle: nothing.
    editor.onEscape = () => {
      const armed = this.pendingConfirm?.kind === 'escape';
      this.clearPendingConfirm();
      if (editor.restoreHistoryDraft()) return;
      if (this.controller?.getState().busy !== true) return;
      if (editor.getText().length === 0 || armed) {
        void this.abortActivePrompt();
        return;
      }
      this.armConfirm('escape');
    };
    editor.onNonEscapeInput = () => {
      this.clearPendingConfirm();
    };
    editor.onShiftTab = () => {
      void this.applyPlanMode(!this.state.appState.planMode).catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
    };
    editor.onToggleToolExpand = () => {
      this.toggleToolOutput();
    };
    editor.onOpenExternalEditor = () => {
      if (this.state.externalEditorRunning) return;
      const command = resolveEditorCommand(this.state.appState.editorCommand);
      if (command === undefined) {
        this.showStatus('No external editor is configured.', 'error');
        return;
      }
      void this.openExternalEditor(command);
    };
    editor.onCtrlS = () => {
      void this.steerPrompt().catch((error: unknown) => this.showSubmissionError(error));
    };
    editor.onAltEnter = () => {
      const raw = editor.getExpandedText();
      const trimmed = raw.trim();
      if (trimmed === '') return;
      this.clearPendingConfirm();
      const mode = editor.inputMode;
      editor.setText('');
      this.recordInputHistory(raw, mode);
      const submission = { accepted: false };
      void this.handleInput(raw, submission).catch((error: unknown) => {
        if (!submission.accepted && editor.getText() === '') {
          editor.setInputMode(mode);
          editor.setText(raw);
        }
        this.showSubmissionError(error);
      });
    };
    editor.onAltS = () => {
      if (editor.getExpandedText().trim() !== '') return;
      void this.steerPrompt().catch((error: unknown) => this.showSubmissionError(error));
    };
    editor.onToggleMouse = () => {
      this.applyMouseReporting(this.state.appState.mouse === false);
    };
    editor.onCtrlB = () => {
      if (this.controller?.getState().busy !== true) return false;
      void this.detachForegroundTasks().catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
      return true;
    };
    editor.onToggleTodoExpand = () => this.toggleTodoList();
    editor.onTextPaste = () => {
      this.clearPendingConfirm();
    };
    editor.onPasteImage = async () => {
      try {
        return await this.handleClipboardPaste();
      } catch (error) {
        this.showStatus(`Attachment upload failed: ${formatErrorMessage(error)}`, 'error');
        return true;
      }
    };
    let historyBrowseMode: 'prompt' | 'bash' | undefined;
    const updateHistoryFilter = () => {
      const mode = historyBrowseMode ?? editor.inputMode;
      editor.setHistoryFilter(
        mode === 'bash' ? (entry) => entry.startsWith('!') : (entry) => !entry.startsWith('!'),
      );
    };
    editor.onInputModeChange = (mode) => {
      this.setAppState({ inputMode: mode });
      if (historyBrowseMode === undefined) updateHistoryFilter();
    };
    editor.onHistoryDraftSave = () => {
      historyBrowseMode = editor.inputMode;
      updateHistoryFilter();
      return historyBrowseMode;
    };
    editor.onHistoryDraftRestore = (mode) => {
      historyBrowseMode = undefined;
      editor.setInputMode(mode as 'prompt' | 'bash');
      updateHistoryFilter();
    };
    editor.onRecall = (entry) => {
      if (entry.startsWith('!')) {
        editor.setInputMode('bash');
        return entry.slice(1);
      }
      editor.setInputMode('prompt');
      return undefined;
    };
    updateHistoryFilter();
  }

  private toggleToolOutput(): void {
    const expanded = !this.state.toolOutputExpanded;
    this.state.toolOutputExpanded = expanded;
    this.renderer.setExpanded(expanded);
  }

  /** Returns false when the todo list fits and there is nothing to toggle. */
  private toggleTodoList(): boolean {
    if (!this.state.todoPanel.hasOverflow()) return false;
    this.todoExpanded = !this.todoExpanded;
    this.state.todoPanel.setExpanded(this.todoExpanded);
    // The panel sits below the transcript, inside the viewport: a diff render
    // is enough, and a forced one would clear scrollback and replay history.
    this.state.ui.requestRender();
    return true;
  }

  private async loadInputHistory(): Promise<string | undefined> {
    try {
      const entries = await loadInputHistory(getInputHistoryFile(this.startup.workDir));
      for (const entry of entries) this.state.editor.addToHistory(entry.content);
      return entries.at(-1)?.content;
    } catch {
      // History is a convenience: an unreadable file must not block startup.
      return undefined;
    }
  }

  /**
   * Make a submitted input recallable with ↑ and persist it for this working
   * directory. Shell commands keep a leading `!`; the history filter and
   * `onRecall` use it to restore shell mode.
   */
  private recordInputHistory(text: string, mode: 'prompt' | 'bash'): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const entry = mode === 'bash' ? `!${trimmed}` : trimmed;
    const file = getInputHistoryFile(this.startup.workDir);
    this.inputHistory = this.inputHistory.then(async (last) => {
      this.state.editor.addToHistory(entry);
      // A read-only or full home directory must not turn every submit into an error.
      await appendInputHistory(file, entry, last).catch(() => false);
      return entry;
    });
  }

  /**
   * Edit the draft in $VISUAL/$EDITOR. A terminal editor (vim, nano) reads
   * the same tty, so the TUI must let go of it first: stop() leaves raw mode
   * and removes the stdin reader, and no frame is drawn over the editor until
   * start() takes the terminal back.
   */
  private async openExternalEditor(command: string): Promise<void> {
    const { editor, ui } = this.state;
    this.state.externalEditorRunning = true;
    const seed = editor.getExpandedText();
    // Focus reports would reach the editor as stray `ESC [ I` input.
    const trackFocus = this.disposeFocusTracking !== undefined;
    this.disposeFocusTracking?.();
    this.disposeFocusTracking = undefined;
    // Fullscreen only needs the alternate screen released; a plain stop()
    // would replay the whole transcript into the main screen.
    ui.stop({ preserveScreen: ui.mode === 'fullscreen' ? true : undefined });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    try {
      const text = await editInExternalEditor(seed, command);
      // Editors end the file with a newline the draft never had.
      if (text !== undefined) editor.setText(text.replaceAll('\r\n', '\n').replace(/\n$/u, ''));
    } catch (error) {
      this.showStatus(`External editor failed: ${formatErrorMessage(error)}`, 'error');
    } finally {
      // The child shared stdin; pause it so start() attaches a fresh reader.
      process.stdin.pause();
      ui.start();
      if (trackFocus) this.disposeFocusTracking = installTerminalFocusTracking(this.state);
      ui.requestRender(true);
      this.state.externalEditorRunning = false;
    }
  }

  private async handleClipboardPaste(): Promise<boolean> {
    const media = await readClipboardMedia();
    if (media === null) return false;
    if (media.kind === 'image') {
      const dimensions = parseImageMeta(media.bytes);
      if (dimensions === null) return false;
      const attachment = this.imageAttachments.addImage(
        media.bytes,
        media.mimeType,
        dimensions.width,
        dimensions.height,
      );
      this.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
      this.state.ui.requestRender();
      attachment.pending = this.client.klient.global.files
        .save({
          data: media.bytes,
          filename: `clipboard.${imageExtension(media.mimeType)}`,
          mimeType: media.mimeType,
          expiresInSec: MEDIA_STAGING_TTL_SECONDS,
        })
        .then(async (upload) => {
          const fileExpiresAt = parseUploadExpiry(upload);
          if (fileExpiresAt === undefined) {
            await this.ownInvalidUpload(upload.id);
            throw new Error('Attachment upload did not include an expiry.');
          }
          const completed = this.imageAttachments.completeImage(attachment, {
            bytes: media.bytes,
            mime: media.mimeType,
            width: dimensions.width,
            height: dimensions.height,
            fileId: upload.id,
            fileExpiresAt,
          });
          if (completed === undefined) await this.client.klient.global.files.delete(upload.id);
        })
        .catch((error: unknown) => {
          attachment.pending = undefined;
          this.showStatus(`Attachment upload failed: ${formatErrorMessage(error)}`, 'error');
        });
      return true;
    }
    const attachment = this.imageAttachments.addVideo(
      media.mimeType,
      media.sourcePath,
      media.filename,
    );
    this.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.state.ui.requestRender();
    attachment.pending = readFile(media.sourcePath)
      .then((data) =>
        this.client.klient.global.files.save({
          data,
          filename: media.filename,
          mimeType: media.mimeType,
          expiresInSec: MEDIA_STAGING_TTL_SECONDS,
        }),
      )
      .then(async (upload) => {
        const fileExpiresAt = parseUploadExpiry(upload);
        if (fileExpiresAt === undefined) {
          await this.ownInvalidUpload(upload.id);
          throw new Error('Attachment upload did not include an expiry.');
        }
        const completed = this.imageAttachments.completeVideo(attachment, {
          fileId: upload.id,
          fileExpiresAt,
        });
        if (completed === undefined) await this.client.klient.global.files.delete(upload.id);
      })
      .catch((error: unknown) => {
        attachment.pending = undefined;
        this.showStatus(`Attachment upload failed: ${formatErrorMessage(error)}`, 'error');
      });
    return true;
  }

  private async handleInterrupt(kind: 'ctrl-c'): Promise<void> {
    // A draft is always cleared first (Ctrl+- restores it), and clearing never
    // arms exit, so the shell habit of pressing Ctrl-C twice to drop a line
    // cannot quit the app.
    if (this.state.editor.getText().length > 0) {
      this.state.editor.setText('', { preservePasteRegistry: true });
      this.armConfirm('draft-cleared');
      return;
    }
    if (this.controller?.getState().busy === true) {
      this.clearPendingConfirm();
      await this.abortActivePrompt();
      return;
    }
    this.confirmExit(kind);
  }

  private async abortActivePrompt(): Promise<void> {
    try {
      await this.controller?.abortActive();
    } catch (error) {
      this.showStatus(formatErrorMessage(error), 'error');
    }
  }

  private restorePromptDraft(content: readonly MessageContent[], queued = false): void {
    const editor = this.state.editor;
    if (editor.inputMode === 'bash' && editor.getText() !== '') {
      this.showStatus('Your message was not put back; press ↑ to recall it.', { transient: true });
      return;
    }
    editor.setInputMode('prompt');
    const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n\n');
    const draft = editor.getText();
    editor.setText([draft, text].filter((part) => part !== '').join('\n\n'), { preservePasteRegistry: true });
    const notice = queued ? 'Withdrew the queued message; it is back in the input box.' : 'Your message is back in the input box.';
    this.showStatus(content.some((part) => part.type !== 'text')
      ? 'Your message is back in the input box; attach its files again.' : notice, { transient: true });
  }

  private async unqueuePrompt(): Promise<void> {
    const controller = this.controller;
    const id = controller?.getState().queuedPromptIds.at(-1);
    if (controller === undefined || id === undefined) {
      this.showStatus('Nothing is queued.', { transient: true });
      return;
    }
    const content = await controller.readQueuedPromptContent(id);
    if (content === undefined) {
      this.showStatus('That message has already started.', { transient: true });
      return;
    }
    if (this.controller !== controller) return;
    const withdrawn = await controller.abortPrompt(id);
    if (this.controller !== controller) return;
    if (!withdrawn) {
      this.showStatus('That message has already started.', { transient: true });
      return;
    }
    this.restorePromptDraft(content, true);
  }

  private confirmExit(kind: 'ctrl-c' | 'ctrl-d'): void {
    if (this.pendingConfirm?.kind === kind) {
      this.clearPendingConfirm();
      void this.stop();
      return;
    }
    this.armConfirm(kind);
  }

  private armConfirm(kind: NonNullable<DaemonTUI['pendingConfirm']>['kind']): void {
    this.clearPendingConfirm();
    const timer = setTimeout(() => {
      if (this.pendingConfirm?.timer !== timer) return;
      this.clearPendingConfirm();
      this.state.ui.requestRender();
    }, kind === 'escape' ? INTERRUPT_CONFIRM_WINDOW_MS : EXIT_CONFIRM_WINDOW_MS);
    this.pendingConfirm = { kind, timer };
    this.state.footer.setTransientHint(
      kind === 'draft-cleared' ? 'Ctrl+- to restore' : kind === 'ctrl-c' ? CTRL_C_HINT : kind === 'ctrl-d' ? CTRL_D_HINT : ESC_INTERRUPT_HINT,
    );
    this.state.ui.requestRender();
  }

  private clearPendingConfirm(): void {
    if (this.pendingConfirm === undefined) return;
    clearTimeout(this.pendingConfirm.timer);
    this.pendingConfirm = undefined;
    this.state.footer.setTransientHint(null);
  }

  private async configureExplicitSources(sessionId: string): Promise<void> {
    const agentFiles = this.startup.cliOptions.agentFiles;
    const skillDirs = this.startup.cliOptions.skillsDirs;
    if (agentFiles.length === 0 && skillDirs.length === 0) return;
    if (this.sourceOverlaySessionId !== undefined && this.sourceOverlaySessionId !== sessionId) {
      await this.releaseExplicitSources();
    }
    const leaseId = await this.ensureSourceOverlayLease();
    await this.client.updateSessionSourceOverlay(sessionId, {
      lease_id: leaseId,
      agent_files: agentFiles,
      skill_dirs: skillDirs,
    });
    this.sourceOverlaySessionId = sessionId;
  }

  private async ensureSourceOverlayLease(): Promise<string> {
    const previousLeaseId = this.sourceOverlayLeaseId;
    const lease = await this.client.renewServerLease(previousLeaseId);
    this.sourceOverlayLeaseId = lease.lease_id;
    this.sourceOverlayLeaseExpiresAt = lease.expires_at;
    if (previousLeaseId !== undefined && lease.lease_id !== previousLeaseId) {
      this.sourceOverlayReattachPending = this.sourceOverlaySessionId !== undefined;
    }
    if (this.sourceOverlayReattachPending && this.sourceOverlaySessionId !== undefined) {
      await this.client.updateSessionSourceOverlay(this.sourceOverlaySessionId, {
        lease_id: lease.lease_id,
        agent_files: this.startup.cliOptions.agentFiles,
        skill_dirs: this.startup.cliOptions.skillsDirs,
      });
      this.sourceOverlayReattachPending = false;
    }
    if (this.sourceOverlayErrorActive) {
      this.sourceOverlayErrorActive = false;
      if (this.activeStatusNotice?.source === 'source-overlay') {
        this.clearStatusNotice();
        if (this.controller !== undefined) {
          this.renderActivityState(this.controller.getState());
        }
      }
    }
    this.sourceOverlayHeartbeatFailures = 0;
    this.scheduleSourceOverlayHeartbeat();
    return lease.lease_id;
  }

  private scheduleSourceOverlayHeartbeat(retry = false): void {
    this.clearSourceOverlayHeartbeat();
    const expiresAt = this.sourceOverlayLeaseExpiresAt;
    if (expiresAt === undefined) return;
    const delay = retry
      ? Math.min(10_000, 250 * 2 ** Math.min(this.sourceOverlayHeartbeatFailures - 1, 6))
      : Math.max(25, Math.floor((expiresAt - Date.now()) / 2));
    this.sourceOverlayHeartbeat = setTimeout(() => {
      this.sourceOverlayHeartbeat = undefined;
      void this.ensureSourceOverlayLease().catch((error: unknown) => {
        this.sourceOverlayHeartbeatFailures += 1;
        this.sourceOverlayErrorActive = true;
        this.showStatus(`Source overlay lease renewal failed: ${formatErrorMessage(error)}`, {
          tone: 'error',
          source: 'source-overlay',
        });
        this.scheduleSourceOverlayHeartbeat(true);
      });
    }, delay);
    this.sourceOverlayHeartbeat.unref();
  }

  private clearSourceOverlayHeartbeat(): void {
    if (this.sourceOverlayHeartbeat === undefined) return;
    clearTimeout(this.sourceOverlayHeartbeat);
    this.sourceOverlayHeartbeat = undefined;
  }

  private async releaseExplicitSources(): Promise<void> {
    const sessionId = this.sourceOverlaySessionId;
    const leaseId = this.sourceOverlayLeaseId;
    if (sessionId === undefined || leaseId === undefined) return;
    await this.client.updateSessionSourceOverlay(sessionId, {
      lease_id: leaseId,
      agent_files: [],
      skill_dirs: [],
    });
    this.sourceOverlaySessionId = undefined;
  }

  private setupAutocomplete(): void {
    const commands = daemonAutocompleteCommands(this.skillCommands, this.agentProfileCommands);
    const skillCommandNames = new Set(
      [...this.skillCommands.values()].map((skill) => skill.commandName),
    );
    this.state.editor.setAutocompleteProvider(
      new FileMentionProvider(
        commands,
        this.startup.workDir,
        this.fdPath,
        this.startup.additionalDirs ?? [],
        () => this.state.appState.inputMode,
        skillCommandNames,
      ),
    );
    this.state.editor.setArgumentHints(
      new Map(
        commands.flatMap((command) => {
          const hint = command.argumentHint;
          if (hint === undefined) return [];
          return [command.name, ...(command.aliases ?? [])].map(
            (name) => [name, hint] as const,
          );
        }),
      ),
    );
    this.state.editor.setSkillCommandNames(skillCommandNames);
  }

  private async refreshAgentCommands(): Promise<void> {
    const profiles = await this.client.listAgentProfiles();
    this.agentProfileCommands.clear();
    for (const profile of profiles.items) {
      if (!profile.disabled) this.agentProfileCommands.set(profile.name.toLowerCase(), profile.name);
    }
    this.setupAutocomplete();
  }

  private async refreshSkillCommands(sessionId: string): Promise<void> {
    const response = await this.client.listSkills(sessionId);
    this.skillCommands.clear();
    for (const skill of daemonSkillCommands(response.skills)) {
      this.skillCommands.set(skill.commandName.toLowerCase(), skill);
    }
    this.setupAutocomplete();
  }

  private async initializeSession(): Promise<void> {
    const sessionFlag = this.startup.cliOptions.session;
    if (sessionFlag === '') {
      await this.showSessionPicker();
      return;
    }
    if (sessionFlag !== undefined) {
      await this.openSession(sessionFlag);
      return;
    }
    if (!this.startup.cliOptions.continue) {
      await this.createSession();
      return;
    }
    let before: string | undefined;
    for (;;) {
      const page = await this.client.listSessions(50, before);
      const existing = page.items.find((item) => samePath(item.cwd, this.startup.workDir));
      if (existing !== undefined) {
        await this.openSession(existing.id);
        return;
      }
      if (page.nextCursor === undefined) break;
      before = page.nextCursor;
    }
    await this.createSession();
  }

  private async ensureSession(): Promise<SessionController> {
    // The input box is live before startup has opened the session; an Enter
    // pressed in that window must use that session, not create a second one.
    if (this.controller === undefined) await this.sessionReady?.catch(() => {});
    if (this.controller !== undefined) return this.controller;
    await this.createSession();
    return this.controller!;
  }

  private async createSession(
    persona = this.startupOverridesPending ? this.startup.cliOptions.persona : undefined,
  ): Promise<void> {
    const session = await this.client.createSession({
      workDir: this.startup.workDir,
      ephemeral: this.startup.cliOptions.ephemeral === true,
      additionalDirs: this.startup.additionalDirs,
      persona,
    });
    if (this.startup.cliOptions.ephemeral === true) this.temporarySessionIds.add(session.id);
    await this.openSession(session.id);
  }

  private async openSession(sessionId: string): Promise<void> {
    const previous = this.controller;
    await this.programStatus.switchSession(sessionId);
    this.clearStatusNotice();
    this.clearActivityTickTimer();
    this.turnActivityTracker.reset();
    this.lastActivityKind = 'idle';
    this.wasBusy = false;
    if (previous !== undefined && previous.sessionId !== sessionId) {
      await this.clearAttachments();
      this.state.editor.setText('');
      this.renderer.clearNotes();
    }
    this.focusedControllerDispose?.();
    this.focusedControllerDispose = undefined;
    this.mainControllerDispose?.();
    if (
      previous !== undefined &&
      previous.sessionId !== sessionId &&
      this.hasUnsettledAttachmentLeases(previous.sessionId)
    ) {
      this.retainAttachmentSettlementController(previous);
    } else {
      previous?.close();
    }
    this.releaseAttachmentSettlementController(sessionId);
    this.focusedAgentId = 'main';
    this.setAppState({
      model: this.startupOverridesPending ? this.startup.cliOptions.model ?? '' : '',
      agentProfile: this.startupOverridesPending ? this.startup.agentProfile : undefined,
      thinkingEffort: this.startupOverridesPending ? this.startup.cliOptions.thinking ?? 'off' : 'off',
    });
    const sessionView = this.client.klient.session(sessionId).view;
    const watchReconnect = (onSignal: (signal: SessionViewSignal) => void) => (signal: SessionViewSignal) => {
      onSignal(signal);
      if (signal.type === 'ready' && signal.reconnected) void this.programStatus.refreshConfig();
    };
    const controller = new SessionController(this.client, {
      ...sessionView,
      bootstrap: sessionView.bootstrap === undefined ? undefined : (input, onSignal) => sessionView.bootstrap!(input, watchReconnect(onSignal)),
      subscribe: (input, onSignal) => sessionView.subscribe(input, watchReconnect(onSignal)),
    }, sessionId);
    this.controller = controller;
    const unsubscribe = controller.subscribe(() => this.renderSession(controller.getState()));
    const unsubscribeInterrupted = controller.subscribeInterruptedPrompt((content) => this.restorePromptDraft(content));
    this.mainControllerDispose = () => {
      unsubscribe();
      unsubscribeInterrupted();
    };
    await controller.open();
    if (this.controller !== controller) return;
    this.renderSession(controller.getState());
    await this.configureExplicitSources(sessionId);
    if (this.controller !== controller) return;
    await this.applyStartupOverrides(controller);
    const models = await this.refreshModels();
    if (this.controller !== controller) return;
    const view = controller.getState();
    if (view.session !== undefined && !view.busy && !view.model && !view.profile && !this.state.appState.agentProfile && !this.state.appState.model) {
      const [configured, profiles] = await Promise.all([
        this.client.klient.global.config.get<string | undefined>('defaultModel'),
        this.client.listAgentProfiles(view.session.workspace_id),
      ]);
      if (this.controller !== controller) return;
      const profile = profiles.items.find((item) => item.name === 'agent');
      const preferred = models.find((item) => item.id === (profile?.pinned_model_alias ?? configured))
        ?? (models.length === 1 && !profile?.pinned_model_alias ? models[0] : undefined);
      if (profile?.executor !== undefined && profile.executor !== 'native') {
        this.setAppState({ agentProfile: profile.name });
      } else if (preferred !== undefined) {
        this.setAppState({ model: preferred.id, thinkingEffort: profile?.thinking_effort ?? preferred.default_effort ?? 'off' });
      }
    }
    await this.refreshSkillCommands(sessionId);
    await this.refreshAgentCommands();
  }

  private async applyStartupOverrides(controller: SessionController): Promise<void> {
    if (!this.startupOverridesPending) return;
    const permissionMode: PermissionMode | undefined = this.startup.cliOptions.auto
      ? 'auto'
      : this.startup.cliOptions.yolo
        ? 'yolo'
        : undefined;
    const agentConfig: NonNullable<UpdateSessionProfileRequest['agent_config']> = {
      model: this.startup.cliOptions.model,
      profile: this.startup.agentProfile,
      thinking: this.startup.cliOptions.thinking,
      permission_mode: permissionMode,
      plan_mode: this.startup.cliOptions.plan ? true : undefined,
    };
    if (Object.values(agentConfig).some((value) => value !== undefined)) {
      const session = await this.client.updateSessionProfile(controller.sessionId, {
        agent_config: agentConfig,
      });
      controller.handleSessionRecord(session);
      this.setAppState({
        model: agentConfig.model ?? session.agent_config.model ?? this.state.appState.model,
        agentProfile: session.agent_config.profile ?? this.state.appState.agentProfile,
        thinkingEffort: agentConfig.thinking ?? this.state.appState.thinkingEffort,
        permissionMode:
          session.agent_config.permission_mode ?? this.state.appState.permissionMode,
        planMode: session.agent_config.plan_mode ?? this.state.appState.planMode,
      });
    }
    this.startupOverridesPending = false;
  }

  private renderSession(view: SessionViewState): void {
    this.programStatus.update(view);
    this.settleAttachmentLeases(view);
    // An armed Esc has nothing left to interrupt once the turn ends.
    if (!view.busy && this.pendingConfirm?.kind === 'escape') this.clearPendingConfirm();
    if (this.wasBusy && !view.busy) {
      this.completedTurns += 1;
      notifyTerminalOnce(this.state, `turn-complete:${String(this.completedTurns)}`, {
        title: 'Kiki task complete',
        body: view.session?.title ?? undefined,
      });
    }
    this.wasBusy = view.busy;
    if (this.focusedAgentId === 'main') this.renderTranscript(view);
    this.setAppState({
      sessionId: view.sessionId,
      model: view.model ?? this.state.appState.model,
      agentProfile: view.profile ?? this.state.appState.agentProfile,
      permissionMode: view.permissionMode ?? this.state.appState.permissionMode,
      planMode: view.planMode,
      thinkingEffort: view.thinkingEffort ?? this.state.appState.thinkingEffort,
      contextTokens: view.contextTokens ?? 0,
      maxContextTokens: view.maxContextTokens ?? 0,
      contextUsage:
        view.contextTokens !== undefined && view.maxContextTokens !== undefined
          ? view.contextTokens / view.maxContextTokens
          : 0,
      streamingPhase: view.busy ? 'waiting' : 'idle',
      stepRetry:
        view.turnRetry === undefined
          ? null
          : {
              nextAttempt: view.turnRetry.failedAttempt + 1,
              maxAttempts: view.turnRetry.maxAttempts,
              delayMs: view.turnRetry.delayMs,
              errorName: view.turnRetry.errorName ?? 'Error',
              errorMessage: '',
              statusCode: view.turnRetry.statusCode,
              phase: 'backoff',
            },
      sessionTitle: view.session?.title ?? null,
      goal: view.goal,
    });
    this.state.todoPanel.setTodos(
      view.todos.map((todo) => ({
        title: todo.title,
        status:
          todo.status === 'in_progress' || todo.status === 'done' ? todo.status : 'pending',
      })),
    );
    this.state.footer.setBackgroundCounts({
      bashTasks: view.tasks.filter((task) => task.kind === 'bash' && task.status === 'running').length,
      agentTasks: view.tasks.filter(
        (task) => task.kind === 'subagent' && task.status === 'running',
      ).length,
    });
    // Mount (or hold back) approvals first: the activity line reports which.
    this.syncInteractionBlocks(view.blocks);
    this.renderActivityState(view);
  }

  private clearStatusNotice(): void {
    if (this.activeStatusNotice?.timer !== undefined) {
      clearTimeout(this.activeStatusNotice.timer);
    }
    this.activeStatusNotice = undefined;
  }

  private clearActivityTickTimer(): void {
    if (this.activityTickTimer !== undefined) {
      clearInterval(this.activityTickTimer);
      this.activityTickTimer = undefined;
    }
  }

  private syncActivityTickTimer(view: SessionViewState): void {
    const shouldTick =
      view.busy &&
      !view.resyncFailed &&
      !view.resyncing &&
      view.turnRetry === undefined &&
      view.turnStartedAt !== undefined &&
      Number.isFinite(view.turnStartedAt) &&
      view.turnStartedAt <= Date.now();

    if (shouldTick) {
      if (this.activityTickTimer !== undefined) return;
      this.activityTickTimer = setInterval(() => {
        if (this.controller === undefined || this.stopped) return;
        this.renderActivityState(this.controller.getState());
      }, ACTIVITY_TICK_INTERVAL_MS);
      this.activityTickTimer.unref?.();
      return;
    }

    this.clearActivityTickTimer();
  }

  private renderActivityState(view: SessionViewState): void {
    this.syncActivityTickTimer(view);
    const now = Date.now();
    const trackerState = this.turnActivityTracker.update(
      view.busy,
      view.blocks ?? [],
      view.turnStartedAt,
      view.queuedPromptIds,
      now,
    );

    let currentActivityKind: ActivityKind = 'idle';
    let activityMessage: string | undefined;
    let activityTone: 'normal' | 'error' = 'normal';
    let activityLine: ActivityLineParts | undefined;
    const interaction = firstPendingInteraction(view.blocks ?? []);

    if (view.resyncFailed) {
      currentActivityKind = 'resyncFailed';
      activityMessage = 'Session resync failed. Run /reload to retry.';
      activityTone = 'error';
    } else if (view.resyncing) {
      currentActivityKind = 'resyncing';
      activityMessage = `Resyncing session (attempt ${String(view.resyncAttempt)})…`;
    } else if (interaction !== undefined) {
      // awaiting_approval also counts as busy, but the turn is waiting on the
      // user, not working: say so instead of "Working" with a running clock.
      currentActivityKind = 'waiting';
      activityLine = formatWaitingActivityLine(
        interaction.kind,
        this.activeInteractionId !== interaction.id,
      );
    } else if (view.turnRetry !== undefined) {
      currentActivityKind = 'retry';
      activityMessage = `Retrying (attempt ${String(view.turnRetry.failedAttempt + 1)} of ${String(view.turnRetry.maxAttempts)}) in ${String(Math.max(1, Math.ceil(view.turnRetry.delayMs / 1_000)))}s`;
    } else if (view.busy) {
      currentActivityKind = 'busy';
      const runningTasks = view.tasks?.filter((task) => task.status === 'running').length ?? 0;
      this.activityHasDraft = this.state.editor.getText().length > 0;
      activityLine = formatBusyActivityLine({
        runningTasks,
        turnStartedAt: view.turnStartedAt,
        hasResponded: trackerState.hasResponded,
        lastResponseAt: trackerState.lastResponseAt,
        now,
        hasDraft: this.activityHasDraft,
      });
      if (view.queuedPromptIds.length > 0) {
        activityLine = {
          ...activityLine,
          details: [...activityLine.details, 'Ctrl+Enter/Ctrl+S steer queued'],
        };
      }
    }
    if (activityLine !== undefined) activityMessage = activityLineText(activityLine);

    const activityTransition = this.lastActivityKind !== currentActivityKind;
    this.lastActivityKind = currentActivityKind;

    // Resync failed is absolute highest priority and preempts any status notice.
    if (view.resyncFailed) {
      this.clearStatusNotice();
      this.state.activityContainer.clear();
      this.state.activityContainer.addChild(new Spacer(1));
      this.state.activityContainer.addChild(
        new Text(currentTheme.fg('error', activityMessage!), 0, 0),
      );
      this.state.ui.requestRender();
      return;
    }

    // New work/recovery supersedes notices; quiet refreshes leave them readable.
    if (activityTransition && currentActivityKind !== 'idle') {
      this.clearStatusNotice();
    }

    if (activityMessage === undefined) {
      // Idle clears activity, not a result or error the user is still reading.
      if (this.activeStatusNotice?.source === 'activity') {
        this.clearStatusNotice();
      }
      if (this.activeStatusNotice === undefined) {
        this.state.activityContainer.clear();
        this.state.ui.requestRender();
      }
      return;
    }

    // If the active status notice is already from activity, allow it to update with new tick/wait text.
    if (this.activeStatusNotice !== undefined && this.activeStatusNotice.source !== 'activity') {
      return;
    }

    this.showStatus(activityMessage, { tone: activityTone, source: 'activity', activity: activityLine });
  }

  private async steerSubmittedText(raw: string, mode: 'prompt' | 'bash'): Promise<void> {
    const editor = this.state.editor;
    const text = raw.trim();
    const controller = this.controller;
    if (controller === undefined || text === '') return;
    if (controller.getPendingSteers().some((steer) => steer.phase === 'unconfirmed' && steer.text === text)) {
      if (editor.getText() === '') {
        editor.setInputMode(mode);
        editor.setText(raw);
      }
      this.showStatus('Prompt delivery is unconfirmed. Check the queue before retrying.', 'error');
      return;
    }
    editor.disableSubmit = true;
    try {
      const prepared = await prepareDaemonPrompt(text, this.imageAttachments, this.fileAttachments, {
        refreshMedia: (attachment) => this.refreshMediaAttachment(attachment),
        refreshFile: (attachment) => this.refreshFileAttachment(attachment),
      });
      const skillMap = new Map<string, string>();
      for (const skill of this.skillCommands.values()) {
        skillMap.set(skill.commandName, skill.name);
        skillMap.set(skill.name, skill.name);
      }
      const skills = extractInlineSkillActivations(text, skillMap);
      const promptId = newSteerPromptId();
      let acknowledged = false;
      const result = await controller
        .sendPromptNow({
          text,
          content: prepared?.content,
          promptId,
          skills: skills.length === 0 ? undefined : skills.map((skill) => ({ name: skill.skillName })),
          onAcknowledged: () => {
            acknowledged = true;
            this.recordInputHistory(text, mode);
          },
        })
        .catch((error: unknown) => {
          if (error instanceof SendNowError && error.reason === 'unknown' && prepared !== undefined) {
            for (const id of [...prepared.mediaUploadIds, ...prepared.fileUploadIds]) {
              this.unconfirmedUploadIds.add(id);
            }
          }
          if (!acknowledged && this.controller === controller && editor.getText() === '') {
            editor.setInputMode(mode);
            editor.setText(raw);
          }
          throw error;
        });
      if (
        prepared !== undefined &&
        this.controller === controller &&
        (result.outcome === 'accepted' ||
          result.outcome === 'steered' ||
          result.outcome === 'started' ||
          result.outcome === 'queued')
      ) {
        this.handoffPreparedMedia(prepared, controller, { promptId });
      }
      this.showStatus(
        `Prompt steering: ${result.outcome.replaceAll('_', ' ')}${result.reason === undefined ? '.' : ` (${result.reason.replaceAll('_', ' ')}).`}`,
        { tone: result.outcome === 'failed' ? 'error' : 'normal', transient: true },
      );
    } catch (error) {
      if (this.controller === controller && editor.getText() === '') {
        editor.setInputMode(mode);
        editor.setText(raw);
      }
      throw error;
    } finally {
      editor.disableSubmit = false;
    }
  }

  private async steerPrompt(): Promise<void> {
    this.clearPendingConfirm();
    const editor = this.state.editor;
    const text = editor.getExpandedText().trim();
    const controller = this.controller;
    if (controller?.getState().busy !== true || (editor.inputMode !== 'bash' && text.startsWith('/'))) {
      if (text !== '') editor.handleInput('\r');
      else this.showStatus('No prompt to steer.', { transient: true });
      return;
    }
    let result: Awaited<ReturnType<SessionController['steerQueued']>> | Awaited<ReturnType<SessionController['sendPromptNow']>>;
    if (text !== '' && editor.inputMode !== 'bash' && !text.startsWith('!')) {
      if (controller.getPendingSteers().some((steer) => steer.phase === 'unconfirmed' && steer.text === text)) {
        this.showStatus('Prompt delivery is unconfirmed. Check the queue before retrying.', 'error');
        return;
      }
      if (editor.disableSubmit) return;
      editor.disableSubmit = true;
      try {
        const draft = editor.getText();
        const prepared = await prepareDaemonPrompt(text, this.imageAttachments, this.fileAttachments, {
          refreshMedia: (attachment) => this.refreshMediaAttachment(attachment),
          refreshFile: (attachment) => this.refreshFileAttachment(attachment),
        });
        const skillMap = new Map<string, string>();
        for (const skill of this.skillCommands.values()) {
          skillMap.set(skill.commandName, skill.name);
          skillMap.set(skill.name, skill.name);
        }
        const skills = extractInlineSkillActivations(text, skillMap);
        const promptId = newSteerPromptId();
        result = await controller.sendPromptNow({
          text,
          content: prepared?.content,
          promptId,
          skills: skills.length === 0 ? undefined : skills.map((skill) => ({ name: skill.skillName })),
          onAcknowledged: () => {
            this.recordInputHistory(text, editor.inputMode);
            if (this.controller === controller && editor.getText() === draft) editor.setText('');
          },
        }).catch((error: unknown) => {
          if (error instanceof SendNowError && error.reason === 'unknown' && prepared !== undefined) {
            for (const id of [...prepared.mediaUploadIds, ...prepared.fileUploadIds]) this.unconfirmedUploadIds.add(id);
          }
          if (error instanceof SendNowError && error.reason === 'refused' && this.controller === controller && editor.getText() === '') editor.setText(text);
          throw error;
        });
        if (prepared !== undefined && this.controller === controller && editor.getText() === '' &&
            (result.outcome === 'accepted' || result.outcome === 'steered' || result.outcome === 'started' || result.outcome === 'queued')) {
          this.handoffPreparedMedia(prepared, controller, { promptId });
        }
      } finally {
        editor.disableSubmit = false;
      }
    } else {
      const promptId = controller.getState().queuedPromptIds[0];
      if (promptId === undefined) {
        this.showStatus('No prompt to steer.', { transient: true });
        return;
      }
      result = await controller.steerQueued(promptId);
    }
    this.showStatus(
      `Prompt steering: ${result.outcome.replaceAll('_', ' ')}${result.reason === undefined ? '.' : ` (${result.reason.replaceAll('_', ' ')}).`}`,
      { tone: result.outcome === 'failed' ? 'error' : 'normal', transient: true },
    );
  }

  private async detachForegroundTasks(): Promise<void> {
    const controller = this.controller!;
    const agent = this.client.klient.session(controller.sessionId).agent('main');
    const tasks = await agent.getTasks({ activeOnly: true });
    const foreground = tasks.filter((task) => task.status === 'running' && task.detached === false);
    const results = await Promise.all(foreground.map((task) => agent.detachTask(task.taskId)));
    const detached = results.filter((task) => task?.status === 'running' && task.detached === true).length;
    this.showStatus(detached === 0
      ? 'No foreground task to move to background.'
      : `Moved ${String(detached)} foreground task${detached === 1 ? '' : 's'} to background.`,
    { transient: true });
  }

  private showSubmissionError(error: unknown): void {
    const cause = error instanceof SendNowError && error.reason === 'submit' ? error.cause : error;
    if (cause instanceof ApiError && ([ErrorCode.AUTH_PROVISIONING_REQUIRED, ErrorCode.AUTH_TOKEN_MISSING, ErrorCode.AUTH_TOKEN_UNAUTHORIZED] as number[]).includes(cause.code)) {
      this.programStatus.requireAuth(formatErrorMessage(cause));
    }
    this.showStatus(error instanceof SendNowError && error.reason === 'unknown'
      ? 'Prompt delivery is unconfirmed. Check the queue before retrying.'
      : formatErrorMessage(error), 'error');
  }

  /** `submission.accepted` turns true once the daemon has taken the input. */
  private async handleInput(raw: string, submission?: { accepted: boolean }): Promise<void> {
    const text = raw.trim();
    if (text === '') return;
    if (this.state.editor.inputMode === 'bash') {
      this.state.editor.setInputMode('prompt');
      const controller = await this.ensureSession();
      await this.client.runShellCommand(controller.sessionId, raw);
      return;
    }
    if (text.startsWith('/')) {
      await this.handleSlash(text);
      return;
    }
    if (this.controller?.getPendingSteers().some((steer) => steer.phase === 'unconfirmed' && steer.text === text)) {
      if (submission !== undefined) submission.accepted = true;
      if (this.state.editor.getText() === '') this.state.editor.setText(raw);
      this.showStatus('Prompt delivery is unconfirmed. Check the queue before retrying.', 'error');
      return;
    }
    await this.sendPrompt(raw, undefined, submission);
  }

  private async sendPrompt(
    text: string,
    profile?: string,
    submission?: { accepted: boolean },
  ): Promise<void> {
    const controller = await this.ensureSession();
    if (profile === undefined && !this.state.appState.agentProfile && !this.state.appState.model &&
      controller.getState().goal?.status !== 'active') {
      if (this.state.editor.getText() === '') this.state.editor.setText(text);
      await this.showModelPicker();
      return;
    }
    const prepared = await prepareDaemonPrompt(text, this.imageAttachments, this.fileAttachments, {
      refreshMedia: (attachment) => this.refreshMediaAttachment(attachment),
      refreshFile: (attachment) => this.refreshFileAttachment(attachment),
    });
    if (profile === undefined) {
      const skillMap = new Map<string, string>();
      for (const skill of this.skillCommands.values()) {
        skillMap.set(skill.commandName, skill.name);
        skillMap.set(skill.name, skill.name);
      }
      const inlineSkills = extractInlineSkillActivations(text, skillMap);
      if (inlineSkills.length > 0) {
        if (prepared?.hasFileAttachment === true) {
          throw new Error('File attachments cannot be combined with inline skills.');
        }
        const result = await this.client.klient
          .session(controller.sessionId)
          .agent('main')
          .promptWithSkills({
            input: prepared?.engineContent ?? [{ type: 'text', text }],
            skills: inlineSkills.map((skill) => ({ name: skill.skillName })),
          });
        if (submission !== undefined) submission.accepted = true;
        if (prepared !== undefined) {
          this.handoffPreparedMedia(prepared, controller, {
            promptId: result.prompt_id,
            turnId: result.turn_id,
            promptState: result.state,
          });
        }
        await controller.resync();
        return;
      }
      if (controller.getState().goal?.status === 'active') {
        if (prepared?.hasFileAttachment === true) {
          throw new Error('File attachments cannot be steered into an active goal.');
        }
        const result = await this.client.klient.session(controller.sessionId).agent('main').steer({
          input: prepared?.engineContent ?? [{ type: 'text', text }],
        });
        if (submission !== undefined) submission.accepted = true;
        if (result === undefined || result === null) {
          await controller.resync();
          if (prepared !== undefined) {
            const view = controller.getState();
            if (view.busy || view.goal?.status === 'active') {
              this.handoffPreparedMediaToExpiry(prepared);
            } else {
              await this.releasePreparedMedia(prepared);
            }
          }
          return;
        }
        if (prepared !== undefined) {
          this.handoffPreparedMedia(prepared, controller, { turnId: result.turn_id });
        }
        await controller.resync();
        return;
      }
    }
    const result = await controller.sendPrompt({
      text,
      content: prepared?.content,
      profile,
      model:
        profile === undefined && this.state.appState.model !== ''
          ? this.state.appState.model
          : undefined,
      thinking: profile === undefined ? this.state.appState.thinkingEffort : undefined,
      permissionMode: this.state.appState.permissionMode,
      planMode: this.state.appState.planMode,
    });
    if (submission !== undefined) submission.accepted = true;
    if (prepared !== undefined) {
      this.handoffPreparedMedia(prepared, controller, {
        promptId: result.prompt_id,
        promptState: result.status,
      });
      await controller.resync();
    }
  }

  private refreshMediaAttachment(attachment: MediaAttachment): Promise<void> {
    return this.refreshAttachmentOnce(attachment, () => this.performMediaAttachmentRefresh(attachment));
  }

  private async performMediaAttachmentRefresh(attachment: MediaAttachment): Promise<void> {
    const previousFileId = attachment.fileId;
    attachment.fileId = undefined;
    attachment.fileExpiresAt = undefined;
    try {
      const data = attachment.kind === 'image' ? attachment.bytes : await readFile(attachment.sourcePath);
      const upload = await this.client.klient.global.files.save({
        data,
        filename:
          attachment.kind === 'image'
            ? `clipboard.${imageExtension(attachment.mime)}`
            : attachment.filename,
        mimeType: attachment.mime,
        expiresInSec: MEDIA_STAGING_TTL_SECONDS,
      });
      const expiresAt = parseUploadExpiry(upload);
      if (expiresAt === undefined) {
        await this.ownInvalidUpload(upload.id);
        throw new Error('The refreshed upload did not include an expiry.');
      }
      attachment.fileId = upload.id;
      attachment.fileExpiresAt = expiresAt;
      if (previousFileId !== undefined && previousFileId !== upload.id) {
        await this.client.klient.global.files.delete(previousFileId).catch(() => undefined);
      }
    } catch (error) {
      throw new Error(
        `Attachment refresh failed for ${attachment.placeholder}: ${formatErrorMessage(error)} Try again.`,
        { cause: error },
      );
    }
  }

  private refreshFileAttachment(attachment: DaemonFileAttachment): Promise<void> {
    return this.refreshAttachmentOnce(attachment, () => this.performFileAttachmentRefresh(attachment));
  }

  private async performFileAttachmentRefresh(attachment: DaemonFileAttachment): Promise<void> {
    const previousFileId = attachment.fileId;
    attachment.fileId = undefined;
    attachment.expiresAt = undefined;
    try {
      const data = await readFile(attachment.sourcePath);
      const upload = await this.client.klient.global.files.save({
        data,
        filename: attachment.name,
        mimeType: attachment.mediaType,
        expiresInSec: MEDIA_STAGING_TTL_SECONDS,
      });
      const expiresAt = parseUploadExpiry(upload);
      if (expiresAt === undefined) {
        await this.ownInvalidUpload(upload.id);
        throw new Error('The refreshed upload did not include an expiry.');
      }
      attachment.fileId = upload.id;
      attachment.expiresAt = expiresAt;
      attachment.size = data.byteLength;
      if (previousFileId !== undefined && previousFileId !== upload.id) {
        await this.client.klient.global.files.delete(previousFileId).catch(() => undefined);
      }
    } catch (error) {
      throw new Error(
        `Attachment refresh failed for ${attachment.placeholder}: ${formatErrorMessage(error)} Try again.`,
        { cause: error },
      );
    }
  }

  private refreshAttachmentOnce(attachment: object, refresh: () => Promise<void>): Promise<void> {
    const existing = this.attachmentRefreshes.get(attachment);
    if (existing !== undefined) return existing;
    const pending = refresh().finally(() => {
      this.attachmentRefreshes.delete(attachment);
    });
    this.attachmentRefreshes.set(attachment, pending);
    return pending;
  }

  private async ownInvalidUpload(fileId: string): Promise<void> {
    let cleanup = this.invalidUploadCleanups.get(fileId);
    if (cleanup === undefined) {
      cleanup = { failures: 0, retryTimer: undefined, inFlight: undefined };
      this.invalidUploadCleanups.set(fileId, cleanup);
    }
    await this.attemptInvalidUploadCleanup(fileId, cleanup, true);
  }

  private attemptInvalidUploadCleanup(
    fileId: string,
    cleanup: InvalidUploadCleanup,
    scheduleRetry: boolean,
  ): Promise<unknown> {
    if (cleanup.inFlight !== undefined) return cleanup.inFlight;
    if (cleanup.retryTimer !== undefined) {
      clearTimeout(cleanup.retryTimer);
      cleanup.retryTimer = undefined;
    }
    const inFlight = this.client.klient.global.files
      .delete(fileId)
      .then(() => {
        this.invalidUploadCleanups.delete(fileId);
        return undefined;
      })
      .catch((error: unknown) => {
        cleanup.failures += 1;
        if (scheduleRetry && !this.stopped) {
          cleanup.retryTimer = setTimeout(() => {
            cleanup.retryTimer = undefined;
            void this.attemptInvalidUploadCleanup(fileId, cleanup, true);
          }, mediaDeleteRetryDelay(cleanup.failures));
          cleanup.retryTimer.unref();
        }
        return error;
      })
      .finally(() => {
        cleanup.inFlight = undefined;
      });
    cleanup.inFlight = inFlight;
    return inFlight;
  }

  private async disposeInvalidUploadCleanups(): Promise<void> {
    for (const cleanup of this.invalidUploadCleanups.values()) {
      if (cleanup.retryTimer !== undefined) {
        clearTimeout(cleanup.retryTimer);
        cleanup.retryTimer = undefined;
      }
    }
    await Promise.all(
      [...this.invalidUploadCleanups.values()].flatMap((cleanup) =>
        cleanup.inFlight === undefined ? [] : [cleanup.inFlight],
      ),
    );
    const errors = (
      await Promise.all(
        [...this.invalidUploadCleanups].map(([fileId, cleanup]) =>
          this.attemptInvalidUploadCleanup(fileId, cleanup, false),
        ),
      )
    ).filter((error) => error !== undefined);
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to clean up invalid attachment uploads');
    }
  }

  private handoffPreparedMedia(
    prepared: PreparedDaemonPrompt,
    controller: SessionController,
    identity: {
      readonly promptId?: string;
      readonly turnId?: number;
      readonly promptState?: PromptStatus;
    },
  ): void {
    const uploadIds = [...prepared.mediaUploadIds, ...prepared.fileUploadIds];
    if (uploadIds.length === 0) return;
    for (const id of prepared.imageAttachmentIds) this.imageAttachments.remove(id);
    for (const id of prepared.fileAttachmentIds) this.fileAttachments.delete(id);
    const turnId = identity.turnId === undefined ? undefined : String(identity.turnId);
    const key = identity.promptId === undefined
      ? `turn:${controller.sessionId}:${turnId}`
      : `prompt:${controller.sessionId}:${identity.promptId}`;
    const deadlineAt = Math.min(
      Date.now() + MEDIA_STAGING_TTL_SECONDS * 1_000,
      ...prepared.uploadExpiresAt,
    );
    const lease: AttachmentSettlementLease = {
      sessionId: controller.sessionId,
      promptId: identity.promptId,
      turnId,
      promptState: identity.promptState,
      uploadIds: new Set(uploadIds),
      deadlineAt,
      deadlineTimer: undefined,
      deleteRetryTimer: undefined,
      deleteFailures: 0,
      settled: false,
      releasing: false,
    };
    lease.deadlineTimer = setTimeout(() => {
      this.expireAttachmentSettlementLease(key, lease);
    }, Math.max(0, deadlineAt - Date.now()));
    lease.deadlineTimer.unref();
    this.attachmentSettlementLeases.set(key, lease);
    this.settleAttachmentLeases(controller.getState());
  }

  private handoffPreparedMediaToExpiry(prepared: PreparedDaemonPrompt): void {
    for (const id of prepared.imageAttachmentIds) this.imageAttachments.remove(id);
    for (const id of prepared.fileAttachmentIds) this.fileAttachments.delete(id);
  }

  private async releasePreparedMedia(prepared: PreparedDaemonPrompt): Promise<void> {
    for (const id of prepared.imageAttachmentIds) this.imageAttachments.remove(id);
    for (const id of prepared.fileAttachmentIds) this.fileAttachments.delete(id);
    await Promise.allSettled(
      [...prepared.mediaUploadIds, ...prepared.fileUploadIds].map((fileId) =>
        this.client.klient.global.files.delete(fileId),
      ),
    );
  }

  private hasUnsettledAttachmentLeases(sessionId: string): boolean {
    return [...this.attachmentSettlementLeases.values()].some(
      (lease) => lease.sessionId === sessionId && !lease.settled,
    );
  }

  private retainAttachmentSettlementController(controller: SessionController): void {
    this.sideControllers.add(controller);
    const dispose = controller.subscribe(() => {
      this.settleAttachmentLeases(controller.getState());
    });
    const deadlineAt = Math.min(
      ...[...this.attachmentSettlementLeases.values()]
        .filter((lease) => lease.sessionId === controller.sessionId && !lease.settled)
        .map((lease) => lease.deadlineAt),
    );
    const deadlineTimer = setTimeout(() => {
      this.releaseAttachmentSettlementController(controller.sessionId);
    }, Math.max(0, deadlineAt - Date.now()));
    deadlineTimer.unref();
    this.attachmentControllerLeases.set(controller, { dispose, deadlineTimer });
  }

  private releaseAttachmentSettlementController(sessionId: string): void {
    for (const [controller, lease] of this.attachmentControllerLeases) {
      if (controller.sessionId !== sessionId) continue;
      lease.dispose();
      clearTimeout(lease.deadlineTimer);
      controller.close();
      this.attachmentControllerLeases.delete(controller);
      this.sideControllers.delete(controller);
    }
  }

  private settleAttachmentLeases(view: SessionViewState): void {
    for (const [key, lease] of this.attachmentSettlementLeases) {
      if (lease.sessionId !== view.sessionId || lease.settled) continue;
      const projection = projectAttachmentSettlement(
        {
          promptId: lease.promptId,
          turnId: lease.turnId,
          promptState: lease.promptState,
        },
        view,
      );
      if (projection !== 'terminal') continue;
      lease.settled = true;
      void this.releaseAttachmentSettlementLease(key, lease);
    }
    if (!this.hasUnsettledAttachmentLeases(view.sessionId)) {
      this.releaseAttachmentSettlementController(view.sessionId);
    }
  }

  private async releaseAttachmentSettlementLease(
    key: string,
    lease: AttachmentSettlementLease,
  ): Promise<void> {
    if (lease.releasing || !lease.settled) return;
    if (Date.now() >= lease.deadlineAt) {
      this.expireAttachmentSettlementLease(key, lease);
      return;
    }
    if (lease.deleteRetryTimer !== undefined) {
      clearTimeout(lease.deleteRetryTimer);
      lease.deleteRetryTimer = undefined;
    }
    lease.releasing = true;
    const uploadIds = [...lease.uploadIds];
    const results = await Promise.allSettled(
      uploadIds.map((fileId) => this.client.klient.global.files.delete(fileId)),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') lease.uploadIds.delete(uploadIds[index]!);
    }
    lease.releasing = false;
    if (this.attachmentSettlementLeases.get(key) !== lease) return;
    if (lease.uploadIds.size === 0) {
      this.completeAttachmentSettlementLease(key, lease);
      return;
    }
    if (this.stopped || Date.now() >= lease.deadlineAt) {
      this.expireAttachmentSettlementLease(key, lease);
      return;
    }
    lease.deleteFailures += 1;
    const retryDelay = Math.min(
      mediaDeleteRetryDelay(lease.deleteFailures),
      lease.deadlineAt - Date.now(),
    );
    lease.deleteRetryTimer = setTimeout(() => {
      lease.deleteRetryTimer = undefined;
      void this.releaseAttachmentSettlementLease(key, lease);
    }, retryDelay);
    lease.deleteRetryTimer.unref();
  }

  private completeAttachmentSettlementLease(
    key: string,
    lease: AttachmentSettlementLease,
  ): void {
    if (lease.deadlineTimer !== undefined) clearTimeout(lease.deadlineTimer);
    if (lease.deleteRetryTimer !== undefined) clearTimeout(lease.deleteRetryTimer);
    this.attachmentSettlementLeases.delete(key);
  }

  private expireAttachmentSettlementLease(key: string, lease: AttachmentSettlementLease): void {
    this.completeAttachmentSettlementLease(key, lease);
    if (!this.hasUnsettledAttachmentLeases(lease.sessionId)) {
      this.releaseAttachmentSettlementController(lease.sessionId);
    }
  }

  private async releaseSettledAttachmentLeases(): Promise<void> {
    await Promise.all(
      [...this.attachmentSettlementLeases]
        .filter(([, lease]) => lease.settled)
        .map(([key, lease]) => this.releaseAttachmentSettlementLease(key, lease)),
    );
  }

  private clearAttachmentSettlementTimers(): void {
    for (const lease of this.attachmentSettlementLeases.values()) {
      if (lease.deadlineTimer !== undefined) clearTimeout(lease.deadlineTimer);
      if (lease.deleteRetryTimer !== undefined) clearTimeout(lease.deleteRetryTimer);
    }
  }

  private async clearAttachments(): Promise<void> {
    const uploadIds = [
      ...this.imageAttachments.clear(),
      ...[...this.fileAttachments.values()].flatMap((attachment) =>
        attachment.fileId === undefined ? [] : [attachment.fileId],
      ),
    ];
    this.fileAttachments.clear();
    this.nextFileAttachmentId = 1;
    await Promise.allSettled(
      uploadIds.filter((fileId) => !this.unconfirmedUploadIds.has(fileId))
        .map((fileId) => this.client.klient.global.files.delete(fileId)),
    );
  }

  private async handleSlash(text: string): Promise<void> {
    const { token, rawToken, args } = parseDaemonSlashInput(text);
    const resolved = resolveDaemonCommand(token, args);
    if (resolved === undefined) {
      const skill = this.skillCommands.get(token) ?? (token.startsWith('skill:')
        ? [...this.skillCommands.values()].find((entry) => entry.name.toLowerCase() === token.slice(6))
        : undefined);
      if (skill !== undefined) {
        const controller = await this.ensureSession();
        const prepared = await prepareDaemonPrompt(args, this.imageAttachments, this.fileAttachments, {
          refreshMedia: (attachment) => this.refreshMediaAttachment(attachment),
          refreshFile: (attachment) => this.refreshFileAttachment(attachment),
        });
        const skillArgs = prepared === undefined ? args : prepared.content
          .filter((part) => part.type === 'text').map((part) => part.text).join('');
        const attachments = prepared?.content.filter((part) => part.type !== 'text');
        await this.client.activateSkill(
          controller.sessionId,
          skill.name,
          skillArgs === '' ? undefined : skillArgs,
          attachments,
        );
        if (prepared !== undefined) this.handoffPreparedMediaToExpiry(prepared);
        return;
      }
      const profile = this.agentProfileCommands.get(token);
      if (profile !== undefined) {
        if (args === '') {
          this.showStatus(`/${profile} requires a prompt.`, 'error');
          return;
        }
        await this.sendPrompt(args, profile);
        return;
      }
      if (this.state.editor.getText() === '') this.state.editor.setText(text);
      this.showStatus(`Unknown command: /${rawToken}`, 'error');
      return;
    }
    if ('status' in resolved) {
      this.showStatus(
        `/${resolved.name} is not available in the terminal UI — ${resolved.description}`,
        'error',
      );
      return;
    }
    const argumentError = validateDaemonCommandArgs(resolved);
    if (argumentError !== undefined) {
      this.showStatus(argumentError, 'error');
      return;
    }
    switch (resolved.name) {
      case 'exit':
        await this.stop();
        return;
      case 'stop':
        if (this.controller?.getState().busy !== true) {
          this.showStatus('Nothing is running.', { transient: true });
          return;
        }
        await this.abortActivePrompt();
        return;
      case 'unqueue':
        await this.unqueuePrompt();
        return;
      case 'queue':
        if (args === '') {
          this.showStatus('/queue requires a prompt.', 'error');
          return;
        }
        await this.sendPrompt(args);
        this.showStatus('Prompt queued.', { transient: true });
        return;
      case 'mouse':
        this.handleMouseCommand(args);
        return;
      case 'expand':
        this.toggleToolOutput();
        return;
      case 'todos':
        if (!this.toggleTodoList()) {
          this.showStatus('The todo list is already shown in full.', { transient: true });
        }
        return;
      case 'sessions':
        await this.showSessionPicker();
        return;
      case 'new':
        await this.createSession();
        return;
      case 'agent':
        if (args === '') await this.showAgentPicker();
        else await this.applyAgentProfile(args);
        return;
      case 'persona':
        await this.handlePersonaCommand(args);
        return;
      case 'model':
        if (args === '') await this.showModelPicker();
        else await this.applyModel(args);
        return;
      case 'permission':
        if (args === '') this.showPermissionPicker();
        else await this.applyPermission(args as PermissionMode);
        return;
      case 'yolo':
        await this.applyPermission(
          this.state.appState.permissionMode === 'yolo' ? 'manual' : 'yolo',
        );
        return;
      case 'auto':
        await this.applyPermission(
          this.state.appState.permissionMode === 'auto' ? 'manual' : 'auto',
        );
        return;
      case 'plan':
        await this.applyPlanMode(!this.state.appState.planMode);
        return;
      case 'agents':
        await this.showAgentRoster();
        return;
      case 'agent-transcript':
        await this.openAgentTranscript(args === '' ? 'main' : args);
        return;
      case 'effort':
        if (args === '') await this.showThinkingPicker();
        else await this.applyThinking(args);
        return;
      case 'title':
        if (args === '') this.showStatus(this.state.appState.sessionTitle ?? 'Untitled session');
        else await this.applyTitle(args);
        return;
      case 'status':
        this.showSessionStatus();
        return;
      case 'usage':
        await this.showUsage();
        return;
      case 'compact':
        await this.compactSession(args);
        return;
      case 'tasks':
        await this.handleTasksCommand(args);
        return;
      case 'fork':
        await this.forkCurrentSession(args);
        return;
      case 'plugins':
        await this.handlePluginsCommand(args);
        return;
      case 'provider':
        await this.handleProviderCommand(args);
        return;
      case 'reload':
        await this.reloadDaemonState();
        return;
      case 'login':
        await this.login(args === '' ? undefined : args);
        return;
      case 'logout':
        await this.logout(args === '' ? undefined : args);
        return;
      case 'mcp':
        await this.showMcpStatus();
        return;
      case 'goal':
        await this.handleGoalCommand(args);
        return;
      case 'settings':
        await this.handleSettingsCommand(args);
        return;
      case 'undo':
        await this.undoLastTurn();
        return;
      case 'attach':
        await this.attachFile(args);
        return;
      case 'experiments':
        await this.showExperiments();
        return;
      case 'export-view':
        await this.exportMarkdown(args);
        return;
      case 'btw':
        await this.askBtw(args);
        return;
      case 'copy':
        await this.copyLastAssistantMessage();
        return;
      case 'editor':
        this.configureEditor(args);
        return;
      case 'init':
        await this.activateInitSkill();
        return;
      case 'theme':
        await this.applyTheme(args);
        return;
      case 'help':
        this.mountEditorReplacement(new HelpPanelComponent({
          commands: daemonHelpCommands(),
          note: `${DAEMON_HELP_DISCOVERY_NOTE}\nLocal docs: ${resolve(resolveDaemonHome(), 'docs')} (en/ or zh/)`,
          maxVisible: () => Math.max(1, this.state.terminal.rows - 10),
          onClose: () => {
            this.restoreEditor();
          },
        }));
        return;
      case 'web': {
        const result = await executeWebCommand(this.client.klient, args);
        this.showStatus(result.message);
        if (result.openUrl !== undefined) openUrl(result.openUrl);
        return;
      }
      case 'version':
        this.showStatus(this.state.appState.version);
        return;
    }
  }

  private async handlePersonaCommand(args: string): Promise<void> {
    const [action, rest] = splitFirst(args);
    if (action === '' || action === 'list') {
      if (rest !== '') throw new Error('Use /persona list or /persona switch <id>.');
      await this.listPersonas();
      return;
    }
    if (action !== 'switch') {
      throw new Error('Use /persona list or /persona switch <id>.');
    }
    if (rest === '') throw new Error('/persona switch requires a persona id.');
    if (/\s/u.test(rest)) throw new Error('/persona switch accepts one persona id.');
    const persona = (await this.client.listPersonas()).find(
      (item) => item.id === rest && !item.archived,
    );
    if (persona === undefined) throw new Error(`Persona "${rest}" was not found.`);
    await this.createSession(persona.id);
    this.showStatus(`Started a new session with persona ${persona.name}.`);
  }

  private async listPersonas(): Promise<void> {
    const personas = (await this.client.listPersonas()).filter((persona) => !persona.archived);
    this.showResult(
      personas.map(formatPersonaSummary).join('\n') || 'No active personas configured.',
    );
  }

  private async refreshModels() {
    const { items } = await this.client.listModels();
    const available = items.filter((item) => item.enabled !== false);
    this.setAppState({ availableModels: Object.fromEntries(available.map((item) => [item.id, {
      provider: item.provider_id,
      model: item.remote_id,
      displayName: item.display_name ?? item.id,
      maxContextSize: item.max_context_size,
      capabilities: item.effective_capabilities ?? item.capabilities,
      supportEfforts: item.support_efforts,
      defaultEffort: item.default_effort,
      protocol: item.effective_protocol ?? item.protocol,
    }])) });
    return available;
  }

  private async applyModel(model: string): Promise<void> {
    const models = await this.refreshModels();
    const choice = models.find((item) => item.id === model);
    if (choice === undefined) throw new Error(`Model "${model}" was not found.`);
    const controller = await this.ensureSession();
    const session = await this.client.setModel(controller.sessionId, model);
    controller.handleSessionRecord(session);
    this.setAppState({ model, thinkingEffort: controller.getState().thinkingEffort ?? choice.default_effort ?? 'off' });
    const { config, kosong } = this.client.klient.global;
    if (!(await config.get<string | undefined>('defaultModel'))) await kosong.setDefaultModel(model);
  }

  private async applyThinking(thinking: string): Promise<void> {
    const controller = await this.ensureSession();
    const session = await this.client.setThinking(controller.sessionId, thinking);
    controller.handleSessionRecord(session);
    this.setAppState({ thinkingEffort: thinking });
  }

  private async applyPlanMode(planMode: boolean): Promise<void> {
    const controller = await this.ensureSession();
    const session = await this.client.setPlanMode(controller.sessionId, planMode);
    controller.handleSessionRecord(session);
    this.setAppState({ planMode });
  }

  private async applyTitle(title: string): Promise<void> {
    const controller = await this.ensureSession();
    const session = await this.client.setTitle(controller.sessionId, title);
    controller.handleSessionRecord(session);
    this.setAppState({ sessionTitle: session.title });
  }

  private showSessionStatus(): void {
    const state = this.state.appState;
    this.showResult(
      [
        `Session: ${state.sessionId === '' ? 'not started' : state.sessionId}`,
        `Working directory: ${state.workDir}`,
        `Daemon: ${this.connection.url}`,
        `Daemon ID: ${this.connection.serverId ?? 'unavailable from this connection'}`,
        `Home ID: ${this.connection.identity?.homeId ?? 'unavailable from this connection'}`,
        `Host ID: ${this.connection.identity?.hostId ?? 'unavailable from this connection'}`,
        `Model: ${state.model === '' ? 'not selected' : state.model}`,
        `Profile: ${state.agentProfile ?? 'default'}`,
        `Thinking: ${state.thinkingEffort}`,
        `Permission: ${state.permissionMode}`,
        `Plan: ${state.planMode ? 'on' : 'off'}`,
      ].join('\n'),
    );
  }

  private async showUsage(): Promise<void> {
    const controller = this.controller;
    if (controller === undefined) {
      this.showResult('No token usage recorded yet.');
      return;
    }
    const usage = await this.client.klient.session(controller.sessionId).agent('main').getUsage();
    const rest = this.client.klient.rest as
      | Partial<typeof this.client.klient.rest>
      | undefined;
    const [accounting, managedRaw] = await Promise.all([
      rest?.sessionUsageAccounting?.(controller.sessionId).catch(() => undefined) ??
        Promise.resolve(undefined),
      rest?.oauth?.usage?.().catch(() => undefined) ?? Promise.resolve(undefined),
    ]);
    const sessionCostUsd =
      accounting !== undefined && accounting.cost_unknown !== true
        ? accounting.cost_usd_estimated
        : undefined;
    const managed = mapManagedUsageResult(managedRaw);
    const state = this.state.appState;
    const panel = new UsagePanelComponent(
      () =>
        buildUsageReportLines({
          sessionUsage: usage,
          sessionCostUsd,
          contextUsage: state.contextUsage,
          contextTokens: state.contextTokens,
          maxContextTokens: state.maxContextTokens,
          managedUsage: managed.report,
          managedUsageError: managed.error,
        }),
      'primary',
      ' Usage ',
    );
    this.renderer.addNote(new PanelNoteComponent(panel));
  }

  private async compactSession(instruction: string): Promise<void> {
    const controller = await this.ensureSession();
    const started = await this.client.klient
      .session(controller.sessionId)
      .agent('main')
      .compact(instruction === '' ? undefined : { instruction });
    this.showStatus(
      started ? 'Context compaction started.' : 'Context compaction is already running.',
      { transient: true },
    );
  }

  private async handleTasksCommand(args: string): Promise<void> {
    const controller = await this.ensureSession();
    const agent = this.client.klient.session(controller.sessionId).agent('main');
    const [action, taskId] = splitFirst(args);
    if (action === 'stop') {
      if (taskId === '') throw new Error('/tasks stop requires a task id.');
      await agent.stopTask({ taskId });
      await controller.resync();
      return;
    }
    if (action === 'output') {
      if (taskId === '') throw new Error('/tasks output requires a task id.');
      this.showResult(await agent.getTaskOutput({ taskId, tail: 20_000 }));
      return;
    }
    if (args !== '') {
      this.showResult(await agent.getTaskOutput({ taskId: args, tail: 20_000 }));
      return;
    }
    const tasks = await agent.getTasks({ activeOnly: false, limit: 100 });
    const picker = new ChoicePickerComponent({
      title: 'Background tasks',
      options: tasks.map((task) => ({
        value: task.taskId,
        label: task.description,
        description: `${task.status} · ${task.taskId}`,
      })),
      onSelect: (id) => {
        this.restoreEditor();
        void agent
          .getTaskOutput({ taskId: id, tail: 20_000 })
          .then((output) => {
            this.showResult(output);
          })
          .catch((error: unknown) => {
            this.showStatus(formatErrorMessage(error), 'error');
          });
      },
      onCancel: () => {
        this.restoreEditor();
      },
    });
    this.mountEditorReplacement(picker);
  }

  private async forkCurrentSession(title: string): Promise<void> {
    const controller = await this.ensureSession();
    const fork = await this.client.klient
      .session(controller.sessionId)
      .fork(title === '' ? undefined : { title });
    this.showStatus(`Session forked: ${fork.id}`);
  }

  private async handlePluginsCommand(args: string): Promise<void> {
    const plugins = this.client.klient.global.plugins;
    const [action, rest] = splitFirst(args);
    if (action === '') {
      const items = await plugins.list();
      this.showResult(
        items
          .map((item) => `${item.id} · ${item.globalEnabled ? 'enabled' : 'disabled'} · ${item.state}`)
          .join('\n') || 'No plugins installed.',
      );
      return;
    }
    if (action === 'marketplace') {
      const pluginConfig = await this.client.klient.global.config.get<{
        readonly marketplace_url?: string;
      }>('plugins');
      const marketplace = await loadPluginMarketplace({
        workDir: this.startup.workDir,
        source: rest === '' ? undefined : rest,
        configSource: pluginConfig?.marketplace_url,
      });
      this.showResult(
        [
          `Source: ${marketplace.source}`,
          ...marketplace.plugins.map((item) => item.displayName),
        ].join('\n'),
      );
      return;
    }
    if (action === 'install') {
      const parsed = parsePluginInstallArgs(rest);
      const source = parsed.source;
      if (source === '') throw new Error('/plugins install [--trust] [--sha256 <64-hex>] requires an explicit source.');
      const previewInput = parsed.sha256 === undefined ? { source } : { source, sha256: parsed.sha256 };
      const plan = await plugins.preview(previewInput);
      this.showResult(`Plugin: ${plan.id}\nSource: ${source}\nContributions: ${plan.contributions.join(', ')}\nTrusted Node code runs with your full account permissions, not in a sandbox.`);
      if (plan.consentRequired && !parsed.trust) throw new Error('To consent once to this source, run /plugins install --trust <source>.');
      await plugins.install(parsed.sha256 === undefined
        ? { source, fingerprint: plan.fingerprint, consent: parsed.trust }
        : { source, sha256: parsed.sha256, fingerprint: plan.fingerprint, consent: parsed.trust });
    } else if (action === 'enable' || action === 'disable') {
      if (rest === '') throw new Error(`/plugins ${action} requires a plugin id.`);
      await plugins.setEnabled({ id: rest, enabled: action === 'enable' });
    } else if (action === 'remove') {
      if (rest === '') throw new Error('/plugins remove requires a plugin id.');
      await plugins.remove(rest);
    } else if (action === 'reload') {
      await plugins.reload();
    } else {
      throw new Error('Use /plugins marketplace|install|enable|disable|remove|reload.');
    }
    await this.controller?.resync();
    await this.refreshAgentCommands();
    if (this.controller !== undefined) await this.refreshSkillCommands(this.controller.sessionId);
  }

  private async handleProviderCommand(args: string): Promise<void> {
    const providers = this.client.klient.global.kosong;
    const [action, rest] = splitFirst(args);
    if (action === '') {
      const items = await providers.listProviders();
      this.showResult(
        items.map((item) => `${item.id} · ${item.status}`).join('\n') || 'No providers configured.',
      );
      return;
    }
    if (action === 'remove') {
      if (rest === '') throw new Error('/provider remove requires a provider id.');
      await providers.removeProvider(rest);
    } else if (action === 'refresh') {
      await providers.refreshProviders();
    } else if (action === 'add') {
      const [id, json] = splitFirst(rest);
      if (id === '' || json === '') {
        throw new Error(
          '/provider add requires an id and JSON configuration. To import a known provider without writing JSON, use `kiki provider catalog add <providerId> --api-key <key>` in a terminal.',
        );
      }
      await providers.addProvider(id, parseProviderInput(json) as never);
    } else {
      throw new Error('Use /provider add|remove|refresh.');
    }
    await this.refreshAgentCommands();
  }

  private async reloadDaemonState(): Promise<void> {
    await this.client.klient.global.config.reload();
    await this.client.klient.global.plugins.reload();
    await this.controller?.resync();
    await this.refreshAgentCommands();
    if (this.controller !== undefined) await this.refreshSkillCommands(this.controller.sessionId);
  }

  private async login(provider: string | undefined): Promise<void> {
    clearTimeout(this.authFlowTimer);
    this.authFlowTimer = undefined;
    const flow = await this.client.klient.global.auth.startLogin(provider);
    if (flow.status === 'authenticated') {
      this.programStatus.requireAuth(undefined);
      this.showStatus(`Authenticated with ${flow.provider}.`, { transient: true });
      return;
    }
    this.programStatus.requireAuth(`Sign in to ${flow.provider} to continue.`);
    openUrl(flow.verification_uri_complete);
    this.showResult(
      `Open ${flow.verification_uri} and enter code ${flow.user_code}. The provider is added to the daemon as soon as authentication completes.`,
    );
    this.watchLogin(flow.provider, flow.flow_id, flow.interval);
  }

  private watchLogin(provider: string, flowId: string, interval: number): void {
    this.authFlowTimer = setTimeout(() => {
      this.authFlowTimer = undefined;
      void this.client.klient.global.auth.flow(provider).then(async (flow) => {
        if (this.stopped || flow?.flow_id !== flowId) return;
        if (flow.status === 'pending') this.watchLogin(provider, flowId, interval);
        else if (flow.status === 'authenticated') {
          this.programStatus.requireAuth(undefined);
          await this.refreshModels();
        }
      }).catch((error: unknown) => this.showStatus(`Sign-in status failed: ${formatErrorMessage(error)}`, 'error'));
    }, interval * 1000);
    this.authFlowTimer.unref();
  }

  private async logout(provider: string | undefined): Promise<void> {
    const result = await this.client.klient.global.auth.logout(provider);
    this.showStatus(`Logged out from ${result.provider}.`, { transient: true });
  }

  private async showMcpStatus(): Promise<void> {
    const controller = await this.ensureSession();
    const servers = await this.client.klient
      .session(controller.sessionId)
      .agent('main')
      .getMcpServers();
    this.showResult(
      servers.map((server) => `${server.name} · ${server.status}`).join('\n') || 'No MCP servers configured.',
    );
  }

  private async handleGoalCommand(args: string): Promise<void> {
    const parsed = parseGoalCommand(args);
    if (parsed.kind === 'error') throw new Error(parsed.message);
    if (parsed.kind === 'next-add' || parsed.kind === 'next-manage') {
      throw new Error('Goal queue management is not available in the terminal UI.');
    }
    const controller = await this.ensureSession();
    if (parsed.kind === 'status') {
      const goal = await this.client.getGoal(controller.sessionId);
      if (goal === null) {
        this.showResult('No active goal. Start one with /goal <objective>.');
        return;
      }
      this.renderer.addNote(new GoalStatusMessageComponent(goal));
      return;
    }
    if (parsed.kind === 'create') {
      if (parsed.replace && (await this.client.getGoal(controller.sessionId)) !== null) {
        await this.applyGoalConfig(controller, { goal_control: 'cancel' });
      }
      await this.applyGoalConfig(controller, { goal_objective: parsed.objective });
      return;
    }
    await this.applyGoalConfig(controller, { goal_control: parsed.kind });
  }

  private async applyGoalConfig(
    controller: SessionController,
    agentConfig: Pick<
      NonNullable<UpdateSessionProfileRequest['agent_config']>,
      'goal_objective' | 'goal_control'
    >,
  ): Promise<void> {
    const session = await this.client.updateSessionProfile(controller.sessionId, {
      agent_config: agentConfig,
    });
    controller.handleSessionRecord(session);
    await controller.resync();
  }

  private persistTuiConfigPatch(patch: Partial<TuiConfig>): void {
    this.currentTuiConfig = { ...this.currentTuiConfig, ...patch };
    if (this.startup.tuiConfigPath !== undefined) {
      void saveTuiConfig(this.currentTuiConfig, this.startup.tuiConfigPath).catch((error: unknown) => {
        this.showStatus(`Failed to save tui.toml: ${formatErrorMessage(error)}`, 'error');
      });
    }
  }

  private applyMouseReporting(enabled: boolean): void {
    this.state.ui.setMouseReporting(enabled);
    this.setAppState({ mouse: enabled });
    this.persistTuiConfigPatch({ mouse: enabled });
    this.showStatus(
      enabled ? 'Mouse reporting on' : 'Mouse reporting off — drag to select text',
      { transient: true },
    );
  }

  private handleMouseCommand(args: string): void {
    const normalized = args.trim().toLowerCase();
    if (normalized === '') {
      this.applyMouseReporting(this.state.appState.mouse === false);
      return;
    }
    if (normalized === 'on' || normalized === 'true' || normalized === 'enable') {
      this.applyMouseReporting(true);
      return;
    }
    if (normalized === 'off' || normalized === 'false' || normalized === 'disable') {
      this.applyMouseReporting(false);
      return;
    }
    this.showStatus('/mouse expects on, off, or no arguments.', 'error');
  }

  private showSettingsDialog(): void {
    const runAsync = (promise: Promise<void>): void => {
      void promise.catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
    };
    const dialog = new SettingsDialogComponent({
      items: [
        {
          id: 'busy_submit',
          label: 'Busy Enter behavior',
          description: 'Send now steers the running turn; Queue waits for the next turn',
          getValue: () =>
            (this.state.appState.busySubmit ?? 'send_now') === 'send_now' ? 'Send now' : 'Queue',
          getValueTone: () => 'primary',
          onActivate: () => {
            const next =
              (this.state.appState.busySubmit ?? 'send_now') === 'send_now' ? 'queue' : 'send_now';
            this.setAppState({ busySubmit: next });
            this.persistTuiConfigPatch({ busySubmit: next });
            this.state.ui.requestRender();
          },
        },
        {
          id: 'mouse',
          label: 'Mouse reporting',
          description: 'Click & wheel navigation (Alt+M toggles for native drag selection)',
          getValue: () => (this.state.appState.mouse !== false ? 'enabled' : 'disabled'),
          onActivate: () => {
            const next = this.state.appState.mouse === false;
            this.state.ui.setMouseReporting(next);
            this.setAppState({ mouse: next });
            this.persistTuiConfigPatch({ mouse: next });
            this.state.ui.requestRender();
          },
        },
        {
          id: 'screen_mode',
          label: 'Screen mode',
          description: 'Applies on next launch',
          getValue: () =>
            (this.state.appState.screenMode ?? 'main') === 'alt'
              ? 'Fullscreen alt'
              : 'Main scrollback',
          getValueTone: () => 'primary',
          onActivate: () => {
            const next = (this.state.appState.screenMode ?? 'main') === 'alt' ? 'main' : 'alt';
            this.setAppState({ screenMode: next });
            this.persistTuiConfigPatch({ screenMode: next });
            this.state.ui.requestRender();
          },
        },
        {
          id: 'show_thinking',
          label: 'Show thinking',
          description: 'Render model reasoning traces in the transcript',
          getValue: () => (this.state.appState.showThinking !== false ? 'enabled' : 'disabled'),
          onActivate: () => {
            const next = this.state.appState.showThinking === false;
            this.renderer.setShowThinking(next);
            this.setAppState({ showThinking: next });
            this.persistTuiConfigPatch({ showThinking: next });
            this.state.ui.requestRender();
          },
        },
        {
          id: 'show_timestamps',
          label: 'Prompt timestamps',
          description: 'Show HH:MM:SS above user prompts',
          getValue: () => (this.state.appState.showTimestamps === true ? 'enabled' : 'disabled'),
          onActivate: () => {
            const next = this.state.appState.showTimestamps !== true;
            this.renderer.setShowTimestamps(next);
            this.setAppState({ showTimestamps: next });
            this.persistTuiConfigPatch({ showTimestamps: next });
            this.state.ui.requestRender();
          },
        },
        {
          id: 'render_latex',
          label: 'LaTeX math',
          description: 'Format inline and block LaTeX equations in assistant replies',
          getValue: () => (this.state.appState.renderLatex !== false ? 'enabled' : 'disabled'),
          onActivate: () => {
            const next = this.state.appState.renderLatex === false;
            setMarkdownRenderLatex(next);
            this.setAppState({ renderLatex: next });
            this.persistTuiConfigPatch({ renderLatex: next });
            this.state.ui.invalidate();
            this.state.ui.requestRender(true);
          },
        },
        {
          id: 'notifications',
          label: 'Notifications',
          description: 'Terminal bell / desktop notification when turns finish or need input',
          getValue: () => {
            const n = this.state.appState.notifications;
            if (!n.enabled) return 'disabled';
            return n.condition === 'always' ? 'Always' : 'Unfocused';
          },
          getValueTone: () =>
            this.state.appState.notifications.enabled ? 'success' : 'textDim',
          onActivate: () => {
            const cur = this.state.appState.notifications;
            const next = !cur.enabled
              ? { enabled: true, condition: 'unfocused' as const }
              : cur.condition === 'unfocused'
                ? { enabled: true, condition: 'always' as const }
                : { enabled: false, condition: cur.condition };
            this.setAppState({ notifications: next });
            this.persistTuiConfigPatch({ notifications: next });
            this.state.ui.requestRender();
          },
        },
        {
          id: 'theme',
          label: 'Theme',
          description: 'Cycle auto, dark, and light color palettes',
          getValue: () => this.state.appState.theme,
          getValueTone: () => 'primary',
          onActivate: () => {
            const order = ['auto', 'dark', 'light'] as const;
            const curIdx = order.indexOf(this.state.appState.theme as (typeof order)[number]);
            const next = order[(curIdx + 1) % order.length]!;
            this.persistTuiConfigPatch({ theme: next });
            runAsync(this.applyTheme(next));
          },
        },
        {
          id: 'permission',
          label: 'Permission mode',
          description: 'Open permission selector (or Space to cycle)',
          getValue: () => this.state.appState.permissionMode,
          getValueTone: () => 'primary',
          onActivate: (trigger) => {
            if (trigger === 'space') {
              const modes: readonly PermissionMode[] = ['manual', 'auto', 'review', 'yolo'];
              const idx = modes.indexOf(this.state.appState.permissionMode);
              const next = modes[(idx + 1) % modes.length]!;
              runAsync(this.applyPermission(next));
              return;
            }
            this.restoreEditor();
            this.showPermissionPicker();
          },
        },
        {
          id: 'plan',
          label: 'Plan mode',
          description: 'Read-only planning mode (Shift+Tab)',
          getValue: () => (this.state.appState.planMode ? 'enabled' : 'disabled'),
          onActivate: () => {
            runAsync(this.applyPlanMode(!this.state.appState.planMode));
          },
        },
        {
          id: 'model',
          label: 'Model',
          description: 'Switch active LLM model',
          getValue: () =>
            this.state.appState.model === '' ? 'not selected' : this.state.appState.model,
          getValueTone: () => (this.state.appState.model === '' ? 'textDim' : 'primary'),
          onActivate: () => {
            this.restoreEditor();
            runAsync(this.showModelPicker());
          },
        },
        {
          id: 'effort',
          label: 'Thinking effort',
          description: 'Adjust model reasoning budget',
          getValue: () => this.state.appState.thinkingEffort,
          getValueTone: () =>
            this.state.appState.thinkingEffort === 'off' ? 'textDim' : 'primary',
          onActivate: () => {
            this.restoreEditor();
            runAsync(this.showThinkingPicker());
          },
        },
        {
          id: 'config_json',
          label: 'View redacted daemon config',
          description: 'Print redacted config JSON to the transcript (/settings json)',
          getValue: () => 'open',
          getValueTone: () => 'textMuted',
          onActivate: () => {
            this.restoreEditor();
            runAsync(this.handleSettingsCommand('json'));
          },
        },
      ],
      onCancel: () => {
        this.restoreEditor();
      },
      onCtrlC: () => {
        this.restoreEditor();
      },
      onCtrlD: () => {
        this.restoreEditor();
      },
    });
    this.mountEditorReplacement(dialog);
  }

  private async handleSettingsCommand(args: string): Promise<void> {
    const config = this.client.klient.global.config;
    const [domain, json] = splitFirst(args);
    if (domain === '') {
      this.showSettingsDialog();
      return;
    }
    if (domain === 'json' && json === '') {
      this.showResult(JSON.stringify(redactSensitive(await config.getAll()), undefined, 2));
      return;
    }
    if (json === '') {
      this.showResult(JSON.stringify(redactSensitive(await config.get(domain)), undefined, 2));
      return;
    }
    const value = JSON.parse(json) as unknown;
    rejectSensitiveConfigWrite(value, []);
    await config.replace({ domain, value });
    await config.reload();
    this.showStatus(`Updated daemon config domain ${domain}.`);
  }

  private async undoLastTurn(): Promise<void> {
    const controller = await this.ensureSession();
    await this.client.undoSession(controller.sessionId);
    await controller.resync({ rewrite: true });
  }

  private async attachFile(path: string): Promise<void> {
    if (path === '') throw new Error('/attach requires a file path.');
    const absolutePath = resolve(this.startup.workDir, path);
    const data = await readFile(absolutePath);
    const name = basename(absolutePath);
    const mediaType = fileMediaType(name);
    const upload = await this.client.klient.global.files.save({
      data,
      filename: name,
      mimeType: mediaType,
      expiresInSec: MEDIA_STAGING_TTL_SECONDS,
    });
    const expiresAt = parseUploadExpiry(upload);
    if (expiresAt === undefined) {
      await this.ownInvalidUpload(upload.id);
      throw new Error('Attachment upload did not include an expiry.');
    }
    const id = this.nextFileAttachmentId++;
    const attachment: DaemonFileAttachment = {
      id,
      fileId: upload.id,
      expiresAt,
      sourcePath: absolutePath,
      name,
      mediaType,
      size: data.byteLength,
      placeholder: `[file #${String(id)} ${name}]`,
    };
    this.fileAttachments.set(id, attachment);
    this.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.state.ui.requestRender();
  }

  private async showExperiments(): Promise<void> {
    const flags = await this.client.klient.global.flags.list();
    this.showResult(
      flags.map((flag) => `${flag.enabled ? 'on' : 'off'} · ${flag.id} · ${flag.source}`).join('\n')
        || 'No experimental features registered.',
    );
  }

  private async exportMarkdown(path: string): Promise<void> {
    const controller = await this.ensureSession();
    const outputPath = resolve(
      this.startup.workDir,
      path === '' ? `kimi-session-${controller.sessionId}.md` : path,
    );
    await writeFile(
      outputPath,
      buildLoadedTranscriptMarkdown({
        sessionId: controller.sessionId,
        workDir: this.startup.workDir,
        blocks: controller.getState().blocks,
        tokenCount: this.state.appState.contextTokens,
        now: new Date(),
      }),
      'utf8',
    );
    this.showStatus(outputPath);
  }

  private async askBtw(question: string): Promise<void> {
    if (question === '') throw new Error('/btw requires a question.');
    const controller = await this.ensureSession();
    const title = `btw · ${question}`;
    const note = new TranscriptNoteComponent(`${title}\nAsking a side agent…`);
    this.renderer.addNote(note);
    const settle = (message: string, answer?: string): void => {
      note.update(message, answer);
      this.state.ui.requestRender();
    };
    try {
      await this.runBtw(controller, question, title, settle);
    } catch (error) {
      settle(`${title}\n${formatErrorMessage(error)}`);
      throw error;
    }
  }

  private async runBtw(
    controller: SessionController,
    question: string,
    title: string,
    settle: (message: string, answer?: string) => void,
  ): Promise<void> {
    const child = await this.client.klient.session(controller.sessionId).fork({ title: 'BTW' });
    const side = new SessionController(this.client, this.client.klient.session(child.id).view, child.id);
    this.sideControllers.add(side);
    await side.open();
    let turnId: string | undefined;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        unsubscribe();
        side.close();
        this.sideControllers.delete(side);
      };
      const finish = () => {
        const view = side.getState();
        if (turnId === undefined || view.turnTail?.turnId !== turnId) return;
        const answer = view.blocks.findLast(
          (block) => block.kind === 'assistant' && block.turnId === turnId && !block.streaming,
        );
        const failure = view.blocks.findLast(
          (block) => block.kind === 'notice' && block.tone === 'danger',
        );
        if (answer?.kind === 'assistant') {
          settle(title, answer.text);
        } else {
          const reason = failure?.kind === 'notice'
            ? failure.text
            : `Side session ${child.id} ended without an answer.`;
          settle(`${title}\n${reason}`);
          this.showStatus(reason, 'error');
        }
        cleanup();
        resolve();
      };
      const unsubscribe = side.subscribe(finish);
      void this.client.klient
        .session(child.id)
        .agent('main')
        .prompt({ input: [{ type: 'text', text: question }] })
        .then((result) => {
          if (result === undefined || result === null) {
            settle(`${title}\nSide session ${child.id} did not start.`);
            this.showStatus(`Side session ${child.id} did not start.`, 'error');
            cleanup();
            resolve();
            return;
          }
          turnId = String(result.turn_id);
          finish();
        })
        .catch((error: unknown) => {
          cleanup();
          reject(error);
        });
    });
  }

  private async copyLastAssistantMessage(): Promise<void> {
    const message = this.controller?.getState().blocks.findLast(
      (block) => block.kind === 'assistant' && !block.streaming,
    );
    if (message?.kind !== 'assistant') throw new Error('No completed assistant message to copy.');
    // Over SSH the native clipboard is the remote machine's, so the copy goes
    // out as an OSC 52 request for the user's own terminal to carry out. A
    // terminal may ignore that request without saying so, and the wording
    // must not claim more than was done.
    const channel = await copyTextToClipboard(message.text);
    if (channel === 'failed') throw new Error('Clipboard access is unavailable.');
    this.showStatus(
      channel === 'osc52'
        ? 'Sent the last assistant message to your terminal\'s clipboard (OSC 52).'
        : 'Copied the last assistant message.',
      { transient: true },
    );
  }

  private configureEditor(command: string): void {
    if (command === '') {
      this.showStatus(resolveEditorCommand(this.state.appState.editorCommand) ?? 'No external editor configured.');
      return;
    }
    this.setAppState({ editorCommand: command });
  }

  private async activateInitSkill(): Promise<void> {
    const controller = await this.ensureSession();
    await this.client.activateSkill(controller.sessionId, 'init');
  }

  private async applyTheme(theme: string): Promise<void> {
    if (theme === '') {
      this.showStatus(this.state.appState.theme);
      return;
    }
    const palette = await getColorPalette(theme as AppState['theme']);
    currentTheme.setPalette(palette);
    this.setAppState({ theme: theme as AppState['theme'] });
    // Transcript sync no longer invalidates the tree, so cached, already
    // coloured lines must be dropped here for the new palette to show.
    this.state.ui.invalidate();
    this.state.ui.requestRender(true);
  }

  private async showThinkingPicker(): Promise<void> {
    const models = await this.client.listModels();
    const model = models.items.find((item) => item.id === this.state.appState.model);
    if (model === undefined) throw new Error('Select a model before choosing thinking effort.');
    const supported = model.support_efforts ?? [];
    const efforts = [
      'off',
      ...(supported.length > 0
        ? sortThinkingEffortsForDisplay(supported)
        : model.capabilities?.includes('thinking') === true
          ? ['on']
          : []),
    ];
    if (!efforts.includes(this.state.appState.thinkingEffort)) {
      efforts.push(this.state.appState.thinkingEffort);
    }
    const picker = new ChoicePickerComponent({
      title: 'Select thinking effort',
      options: efforts.map((effort) => ({ value: effort, label: effort })),
      currentValue: this.state.appState.thinkingEffort,
      onSelect: (effort) => {
        this.restoreEditor();
        void this.applyThinking(effort).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        });
      },
      onCancel: () => {
        this.restoreEditor();
      },
    });
    this.mountEditorReplacement(picker);
  }

  private async showModelPicker(): Promise<void> {
    const models = await this.refreshModels();
    if (models.length === 0) {
      this.programStatus.requireAuth('Sign in with /login or configure a provider to continue.');
      this.showStatus('No models configured. Run /login or configure a provider.', { transient: true });
      return;
    }
    const picker = new ChoicePickerComponent({
      title: 'Select a model',
      options: models.map((item) => ({
        value: item.id,
        label: item.display_name ?? item.id,
        description: item.provider_id,
      })),
      currentValue: this.state.appState.model,
      searchable: true,
      onSelect: (model) => {
        this.restoreEditor();
        void this.applyModel(model).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        });
      },
      onCancel: () => {
        this.restoreEditor();
      },
    });
    this.mountEditorReplacement(picker);
  }

  private async applyAgentProfile(profile: string): Promise<void> {
    const profiles = await this.client.listAgentProfiles();
    if (!profiles.items.some((item) => item.name === profile && !item.disabled)) {
      throw new Error(`Agent profile "${profile}" was not found.`);
    }
    const controller = await this.ensureSession();
    const session = await this.client.setProfile(controller.sessionId, profile);
    controller.handleSessionRecord(session);
    this.setAppState({
      agentProfile: session.agent_config.profile ?? profile,
      model: session.agent_config.model,
      permissionMode: session.agent_config.permission_mode ?? this.state.appState.permissionMode,
      planMode: session.agent_config.plan_mode ?? this.state.appState.planMode,
    });
  }

  private async showAgentPicker(): Promise<void> {
    const profiles = await this.client.listAgentProfiles();
    const picker = new ChoicePickerComponent({
      title: 'Select agent profile',
      options: profiles.items
        .filter((item) => !item.disabled)
        .map((item) => ({
          value: item.name,
          label: item.name,
          description: item.description,
        })),
      currentValue: this.state.appState.agentProfile,
      searchable: true,
      onSelect: (profile) => {
        this.restoreEditor();
        void this.applyAgentProfile(profile).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        });
      },
      onCancel: () => {
        this.restoreEditor();
      },
    });
    this.mountEditorReplacement(picker);
  }

  private async applyPermission(mode: PermissionMode): Promise<void> {
    const controller = await this.ensureSession();
    const session = await this.client.setPermission(controller.sessionId, mode);
    controller.handleSessionRecord(session);
    this.setAppState({ permissionMode: mode });
  }

  private showPermissionPicker(): void {
    const picker = new PermissionSelectorComponent({
      currentValue: this.state.appState.permissionMode,
      onSelect: (mode) => {
        this.restoreEditor();
        void this.applyPermission(mode).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        });
      },
      onCancel: () => {
        this.restoreEditor();
      },
    });
    this.mountEditorReplacement(picker);
  }

  private async showAgentRoster(): Promise<void> {
    const controller = await this.ensureSession();
    const roster = await this.client.klient.session(controller.sessionId).agents();
    const forest = controller.getForest();
    const ids = new Set(['main', ...Object.keys(roster), ...Object.keys(forest?.byId ?? {})]);
    const picker = new ChoicePickerComponent({
      title: 'Agent transcripts',
      options: [...ids].map((agentId) => {
        const meta = roster[agentId];
        const node = forest?.byId[agentId];
        return {
          value: agentId,
          label: node?.label ?? node?.name ?? meta?.userLabel ?? meta?.displayName ?? agentId,
          description: [node?.status, node?.model ?? meta?.model, agentId]
            .filter((value): value is string => value !== undefined)
            .join(' · '),
        };
      }),
      currentValue: this.focusedAgentId,
      searchable: true,
      onSelect: (agentId) => {
        this.restoreEditor();
        void this.openAgentTranscript(agentId).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        });
      },
      onCancel: () => {
        this.restoreEditor();
      },
    });
    this.mountEditorReplacement(picker);
  }

  private async openAgentTranscript(agentId: string): Promise<void> {
    const controller = await this.ensureSession();
    this.focusedControllerDispose?.();
    this.focusedControllerDispose = undefined;
    this.focusedAgentId = agentId;
    controller.setFocusedAgent(agentId);
    if (agentId === 'main') {
      this.renderTranscript(controller.getState());
      return;
    }
    const render = () => this.renderTranscript(controller.getAgentState(agentId));
    this.focusedControllerDispose = controller.subscribeAgent(agentId, render);
    render();
  }

  private renderTranscript(view: SessionViewState): void {
    this.renderer.sync(view.blocks, {
      liveTurnId: view.busy ? latestTurnId(view.blocks) : undefined,
      forest: this.controller?.getForest(),
      tasks: view.tasks,
      ingress: this.focusedAgentId === 'main' ? view.durableIngress : undefined,
    });
  }

  private async showSessionPicker(
    scope: 'cwd' | 'all' = this.state.sessionsScope,
    initialSelectedSessionId?: string,
  ): Promise<void> {
    this.state.sessionsScope = scope;
    let page = await this.client.listSessions(50);
    let nextCursor = page.nextCursor;
    const visibleRows = (items: readonly SessionSummary[]) =>
      items
        .filter((session) => scope === 'all' || samePath(session.cwd, this.startup.workDir))
        .map(sessionRow);
    const initialRows = visibleRows(page.items);
    if (scope === 'cwd') {
      while (initialRows.length === 0 && nextCursor !== undefined) {
        page = await this.client.listSessions(50, nextCursor);
        nextCursor = page.nextCursor;
        initialRows.push(...visibleRows(page.items));
      }
    }
    const picker = new SessionPickerComponent({
      sessions: initialRows,
      loading: false,
      currentSessionId: this.controller?.sessionId ?? '',
      scope,
      initialSelectedSessionId,
      hasMore: nextCursor !== undefined,
      onSelect: (row) => {
        this.restoreEditor();
        void this.openSession(row.id).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        });
      },
      onCancel: () => {
        this.restoreEditor();
      },
      // With a session open these keys only close the picker; the startup
      // picker has no session to return to, so there they exit.
      onCtrlC: () => {
        if (this.controller === undefined) void this.stop();
        else this.restoreEditor();
      },
      onCtrlD: () => {
        if (this.controller === undefined) void this.stop();
        else this.restoreEditor();
      },
      onToggleScope: (selectedSessionId) => {
        void this.showSessionPicker(scope === 'all' ? 'cwd' : 'all', selectedSessionId).catch(
          (error: unknown) => {
            this.showStatus(formatErrorMessage(error), 'error');
          },
        );
      },
      onLoadMore: () => {
        void loadMore(false);
      },
      onSearchDrain: () => {
        void loadMore(true);
      },
      onDeleteRequest: (row) => this.deleteSessionFromPicker(row),
    });
    let loading = false;
    const loadMore = async (drain: boolean): Promise<void> => {
      if (loading || nextCursor === undefined) return;
      loading = true;
      picker.setPaging(true, true);
      try {
        for (;;) {
          page = await this.client.listSessions(50, nextCursor);
          nextCursor = page.nextCursor;
          const appended = visibleRows(page.items);
          picker.appendSessions(appended);
          if (nextCursor === undefined || (!drain && appended.length > 0)) break;
        }
      } catch (error) {
        this.showStatus(formatErrorMessage(error), 'error');
      } finally {
        loading = false;
        picker.setPaging(nextCursor !== undefined, false);
        this.state.ui.requestRender();
      }
    };
    this.mountEditorReplacement(picker);
    this.activeSessionPicker = picker;
  }

  private async deleteSessionFromPicker(row: SessionRow): Promise<void> {
    if (row.id === this.controller?.sessionId) {
      await this.deleteCurrentSessionFromPicker(row);
      return;
    }
    try {
      await this.client.klient.session(row.id).delete();
    } catch (error) {
      this.showStatus(`Failed to delete session ${row.id}: ${formatErrorMessage(error)}`, 'error');
      return;
    }
    if (this.activeSessionPicker !== undefined) {
      await this.showSessionPicker(this.state.sessionsScope);
    }
    this.showStatus('Session deleted.', { transient: true });
  }

  private async deleteCurrentSessionFromPicker(row: SessionRow): Promise<void> {
    this.mainControllerDispose?.();
    this.mainControllerDispose = undefined;
    this.focusedControllerDispose?.();
    this.focusedControllerDispose = undefined;
    this.controller?.close();
    this.controller = undefined;
    try {
      await this.client.klient.session(row.id).delete();
    } catch (error) {
      this.showStatus(`Failed to delete session ${row.id}: ${formatErrorMessage(error)}`, 'error');
      await this.createSession();
      this.restoreEditor();
      return;
    }
    this.restoreEditor();
    await this.createSession();
    this.showStatus('Session deleted.');
  }

  private syncInteractionBlocks(blocks: readonly Block[]): void {
    const interaction = firstPendingInteraction(blocks);
    if (interaction === undefined) {
      this.interactionDeferred = false;
      if (this.activeInteractionId !== undefined) this.restoreEditor();
      this.activeInteractionId = undefined;
      return;
    }
    if (interaction.id === this.activeInteractionId) return;
    notifyTerminalOnce(this.state, `interaction:${interaction.id}`, {
      title: interaction.kind === 'approval' ? 'Kiki needs your approval' : 'Kiki has a question',
      body: interaction.kind === 'approval'
        ? interaction.request.action
        : interaction.request.questions[0]?.question,
    });
    // Never replace a dialog the user opened (a picker, /help): the keys they
    // are pressing for it would land on the approval. The status line says a
    // request is waiting; restoreEditor() shows it once their dialog closes.
    if (
      this.activeInteractionId === undefined &&
      this.state.editorContainer.children[0] !== this.state.editor
    ) {
      this.interactionDeferred = true;
      return;
    }
    this.interactionDeferred = false;
    this.activeInteractionId = interaction.id;
    if (interaction.kind === 'approval') {
      if (interaction.request.tool_name === 'tool' && interaction.request.tool_input_display === undefined) {
        const controller = this.controller!;
        void this.client.klient.session(controller.sessionId).approvals.list().then((requests) => {
          if (this.controller !== controller || this.activeInteractionId !== interaction.id) return;
          const request = requests.find((item) => item.id === interaction.request.approval_id);
          if (request !== undefined) this.showApproval(interaction, adaptApprovalRequest({
            ...request,
            toolCallId: request.toolCallId ?? interaction.request.tool_call_id ?? interaction.request.approval_id,
          }));
        }).catch((error: unknown) => {
          if (this.controller !== controller || this.activeInteractionId !== interaction.id) return;
          this.activeInteractionId = undefined;
          this.showStatus(`Could not load approval: ${formatErrorMessage(error)} Run /reload to retry.`, 'error');
        });
      } else this.showApproval(interaction, approvalPanelData(interaction));
    } else this.showQuestion(interaction);
  }

  private showApproval(block: ApprovalBlock, data: ApprovalPanelData): void {
    // Returning the response promise makes the panel ignore keys until it
    // settles, so a second press cannot answer twice.
    const panel = new ApprovalPanelComponent(
      { data },
      (response) =>
        this.respondApproval(block, response).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        }),
      () => this.toggleToolOutput(),
      (preview) => this.mountEditorReplacement(new ApprovalPreviewViewer({
        block: preview,
        maxRows: () => {
          const { terminal, footer, dockContainer, activityContainer, todoPanelContainer } = this.state;
          const width = Math.max(1, terminal.columns - 2 * CHROME_GUTTER);
          return terminal.rows - footer.render(width).length - activityContainer.render(terminal.columns).length
            - todoPanelContainer.render(terminal.columns).length - (dockContainer === undefined ? 0 : 1);
        },
        onClose: () => this.mountEditorReplacement(panel),
      }, this.state.terminal)),
      this.interactionArming(),
    );
    this.mountEditorReplacement(panel);
  }

  /**
   * Approvals and questions mount on their own, often while the user is
   * typing into the input box they replace. Enter and option keys stay inert
   * until no key has arrived for INTERACTION_ARM_AFTER_MS; the window starts
   * at mount, so it always ends at least that long after the last keystroke
   * the input box received.
   */
  private interactionArming(): { armAfterMs: number; onArmed: () => void } {
    return {
      armAfterMs: INTERACTION_ARM_AFTER_MS,
      onArmed: () => {
        this.state.ui.requestRender();
      },
    };
  }

  private async respondApproval(
    block: ApprovalBlock,
    response: ApprovalPanelResponse,
  ): Promise<void> {
    const decision =
      response.response === 'approved' || response.response === 'approved_for_session'
        ? 'approved'
        : response.response;
    await this.handleInteractionResponse(() =>
      this.client.resolveApproval(this.controller!.sessionId, block.request.approval_id, {
        decision,
        scope: response.response === 'approved_for_session' ? 'session' : undefined,
        feedback: response.feedback,
        selected_label: response.selected_label,
        selected_option_id: response.selected_option_id,
      }),
    );
  }

  private showQuestion(block: QuestionBlock): void {
    const dialog = new QuestionDialogComponent(
      { data: adaptQuestionRequest(block) },
      (response) =>
        this.respondQuestion(block, response).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        }),
      undefined,
      () => this.toggleToolOutput(),
      this.interactionArming(),
    );
    this.mountEditorReplacement(dialog);
  }

  private async respondQuestion(
    block: QuestionBlock,
    response: QuestionPanelResponse,
  ): Promise<void> {
    await this.handleInteractionResponse(() =>
      response.answers.length === 0
        ? this.client.dismissQuestion(this.controller!.sessionId, block.request.question_id)
        : this.client.resolveQuestion(this.controller!.sessionId, block.request.question_id, {
            answers: adaptQuestionResponse(block, response),
            method: response.method,
          }),
    );
  }

  private async handleInteractionResponse(request: () => Promise<unknown>): Promise<void> {
    try {
      await request();
    } catch (error) {
      if (!isSettledInteractionError(error)) {
        this.showStatus(formatErrorMessage(error), 'error');
        return;
      }
    }
    try {
      await this.finishInteractionResponse();
    } catch (error) {
      this.showStatus(formatErrorMessage(error), 'error');
    }
  }

  private async finishInteractionResponse(): Promise<void> {
    this.activeInteractionId = undefined;
    this.restoreEditor();
    await this.controller?.resync();
  }

  private mountEditorReplacement(component: Parameters<TUIState['editorContainer']['addChild']>[0]): void {
    this.activeSessionPicker = undefined;
    if (
      this.activeInteractionId !== undefined &&
      !(component instanceof ApprovalPanelComponent || component instanceof QuestionDialogComponent || component instanceof ApprovalPreviewViewer)
    ) {
      // A dialog the user asked for (e.g. a picker that finished loading after
      // an approval appeared) takes the slot; the approval comes back when it
      // closes instead of being lost behind it.
      this.activeInteractionId = undefined;
      this.interactionDeferred = true;
    }
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(component);
    this.state.ui.setFocus(component);
    this.state.ui.requestRender();
  }

  private restoreEditor(): void {
    this.activeSessionPicker = undefined;
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.state.ui.requestRender();
    if (this.interactionDeferred && this.controller !== undefined) {
      this.interactionDeferred = false;
      const view = this.controller.getState();
      this.syncInteractionBlocks(view.blocks);
      this.renderActivityState(view);
    }
  }

  /**
   * Show a read-out the user asked for (a /status or /usage result, a list)
   * in the transcript, where the next turn does not clear it. Short
   * acknowledgements and errors stay in the status line.
   */
  private showResult(text: string): void {
    this.renderer.addNote(new TranscriptNoteComponent(text));
  }

  private showStatus(
    message: string,
    options?: 'normal' | 'error' | ShowStatusOptions,
  ): void {
    // If resyncFailed is currently active, it has absolute top priority and cannot be overwritten.
    const view = this.controller?.getState();
    if (view?.resyncFailed) {
      this.renderActivityState(view);
      return;
    }

    const normalizedOptions: ShowStatusOptions =
      typeof options === 'string'
        ? { tone: options }
        : options ?? {};
    const tone = normalizedOptions.tone ?? 'normal';
    const policy = resolveStatusNoticePolicy(tone, normalizedOptions);
    this.clearStatusNotice();

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (policy.transient && policy.ttlMs !== undefined) {
      timer = setTimeout(() => {
        if (this.activeStatusNotice?.timer === timer) {
          this.activeStatusNotice = undefined;
          if (this.controller !== undefined) {
            this.renderActivityState(this.controller.getState());
          } else {
            this.state.activityContainer.clear();
            this.state.ui.requestRender();
          }
        }
      }, policy.ttlMs);
      timer.unref?.();
    }

    this.activeStatusNotice = {
      message,
      tone,
      transient: policy.transient,
      source: policy.source,
      timer,
    };

    // The blank line separates the status from the transcript above, like
    // the blank line every transcript block starts with.
    this.state.activityContainer.clear();
    this.state.activityContainer.addChild(new Spacer(1));
    this.state.activityContainer.addChild(
      normalizedOptions.activity !== undefined
        ? new ActivityLineComponent(normalizedOptions.activity)
        : new Text(currentTheme.fg(tone === 'error' ? 'error' : 'textDim', message), 0, 0),
    );
    this.state.ui.requestRender();
  }

  private setAppState(patch: Partial<AppState>): void {
    Object.assign(this.state.appState, patch);
    this.state.footer.setState({ ...this.state.appState });
    this.state.ui.requestRender();
  }
}

export function buildLoadedTranscriptMarkdown(input: {
  readonly sessionId: string;
  readonly workDir: string;
  readonly blocks: readonly Block[];
  readonly tokenCount: number;
  readonly now: Date;
}): string {
  const history = input.blocks.flatMap((block) => {
    if (block.kind !== 'user' && block.kind !== 'assistant') return [];
    return [{
      role: block.kind,
      content: [{ type: 'text', text: block.text }],
      toolCalls: [],
    }];
  });
  return buildExportMarkdown({
    sessionId: input.sessionId,
    workDir: input.workDir,
    history: history as never,
    tokenCount: input.tokenCount,
    now: input.now,
  }).replace(
    '# Kiki Session Export',
    '# Kiki Loaded Transcript View\n\n> Includes only loaded user and assistant text. Tools, media, and other blocks are omitted.',
  );
}

function firstPendingInteraction(
  blocks: readonly Block[],
): ApprovalBlock | QuestionBlock | undefined {
  return blocks.find(
    (block): block is ApprovalBlock | QuestionBlock =>
      (block.kind === 'approval' && block.resolution === undefined) ||
      (block.kind === 'question' && block.outcome === undefined),
  );
}

function isSettledInteractionError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === API_CODES.APPROVAL_ALREADY_RESOLVED ||
      error.code === API_CODES.APPROVAL_EXPIRED ||
      error.code === API_CODES.QUESTION_EXPIRED ||
      error.code === API_CODES.QUESTION_DISMISSED)
  );
}

function approvalPanelData(block: ApprovalBlock): ApprovalPanelData {
  const request = block.request;
  return adaptApprovalRequest({
    turnId: request.turn_id,
    toolCallId: request.tool_call_id,
    toolName: request.tool_name,
    action: request.action,
    display: request.tool_input_display ?? { kind: 'generic', summary: request.action },
  } as Parameters<typeof adaptApprovalRequest>[0]);
}


function sessionRow(session: SessionSummary): SessionRow {
  return {
    id: session.id,
    title: session.title ?? null,
    last_prompt: session.lastPrompt ?? null,
    work_dir: session.cwd ?? '',
    updated_at: session.updatedAt,
    metadata: session.custom,
  };
}

function formatPersonaSummary(persona: DaemonPersonaSummary): string {
  return [persona.id, persona.name, persona.title, persona.job]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(' · ');
}

function splitFirst(value: string): readonly [string, string] {
  const trimmed = value.trim();
  const boundary = trimmed.search(/\s/u);
  return boundary === -1
    ? [trimmed, '']
    : [trimmed.slice(0, boundary), trimmed.slice(boundary).trim()];
}

function samePath(left: string, right: string): boolean {
  return sameWorkDir(left, right);
}

const SENSITIVE_CONFIG_KEY = /(?:api[-_]?key|token|secret|password|authorization|headers|env)/iu;
const PROVIDER_ENV_REFERENCE = /^\$([A-Z_][A-Z0-9_]*)$/u;

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_CONFIG_KEY.test(key) ? '[redacted]' : redactSensitive(child),
    ]),
  );
}

function rejectSensitiveConfigWrite(value: unknown, path: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) rejectSensitiveConfigWrite(child, path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (SENSITIVE_CONFIG_KEY.test(key)) {
      throw new Error(`Settings cannot write sensitive field ${nextPath.join('.')}.`);
    }
    rejectSensitiveConfigWrite(child, nextPath);
  }
}

function parseProviderInput(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Provider configuration must be a JSON object.');
  }
  const input = structuredClone(parsed) as Record<string, unknown>;
  const auth = input['auth'];
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('Provider configuration requires auth.');
  }
  const providerAuth = auth as Record<string, unknown>;
  if (providerAuth['method'] === 'api-key') {
    const match = typeof providerAuth['apiKey'] === 'string'
      ? PROVIDER_ENV_REFERENCE.exec(providerAuth['apiKey'])
      : null;
    if (match === null) {
      throw new Error('Provider API keys must use an environment reference such as $KIMI_API_KEY.');
    }
    const value = process.env[match[1]!];
    if (value === undefined) throw new Error(`Provider API key environment variable ${match[1]} is not set.`);
    providerAuth['apiKey'] = value;
  } else if (providerAuth['method'] !== 'oauth') {
    throw new Error('Provider auth method must be api-key or oauth.');
  }
  rejectSensitiveProviderFields(input, []);
  return input;
}

function rejectSensitiveProviderFields(value: unknown, path: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) rejectSensitiveProviderFields(child, path);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    const isResolvedApiKey = nextPath.length === 2 && nextPath[0] === 'auth' && key === 'apiKey';
    if (!isResolvedApiKey && SENSITIVE_CONFIG_KEY.test(key)) {
      throw new Error(`Provider configuration cannot include plaintext ${nextPath.join('.')}.`);
    }
    rejectSensitiveProviderFields(child, nextPath);
  }
}

function mediaDeleteRetryDelay(failures: number): number {
  return Math.min(
    MEDIA_SETTLEMENT_RETRY_MAX_MS,
    MEDIA_SETTLEMENT_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 6),
  );
}

function parseUploadExpiry(upload: { readonly expires_at?: string }): number | undefined {
  if (upload.expires_at === undefined) return undefined;
  const expiresAt = Date.parse(upload.expires_at);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

function imageExtension(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

function fileMediaType(name: string): string {
  const extension = name.toLowerCase().split('.').at(-1);
  if (extension === undefined) return 'application/octet-stream';
  switch (extension) {
    case 'json':
      return 'application/json';
    case 'md':
      return 'text/markdown';
    case 'txt':
    case 'log':
      return 'text/plain';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

class PanelNoteComponent implements Component {
  constructor(private readonly inner: Component) {}

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    return ['', ...this.inner.render(width)];
  }
}

function mapManagedUsageResult(
  raw: ManagedUsageResult | undefined,
): { readonly report?: ManagedUsageReport; readonly error?: string } {
  if (raw === undefined) return {};
  if (raw.kind === 'error') return { error: raw.message };
  const mapRow = (row: NonNullable<typeof raw.summary>) => ({
    name: row.name,
    window: row.window,
    used: row.used,
    limit: row.limit,
    resetAt: row.reset_at,
  });
  return {
    report: {
      summary: raw.summary === null ? null : mapRow(raw.summary),
      limits: raw.limits.map(mapRow),
      extraUsage:
        raw.extra_usage === null
          ? null
          : {
              balanceCents: raw.extra_usage.balance_cents,
              totalCents: raw.extra_usage.total_cents,
              monthlyChargeLimitEnabled: raw.extra_usage.monthly_charge_limit_enabled,
              monthlyChargeLimitCents: raw.extra_usage.monthly_charge_limit_cents,
              monthlyUsedCents: raw.extra_usage.monthly_used_cents,
              currency: raw.extra_usage.currency,
            },
    },
  };
}

function createOptions(input: DaemonTUIStartupInput): KimiTUIOptions {
  const permissionMode: PermissionMode = input.cliOptions.auto
    ? 'auto'
    : input.cliOptions.yolo
      ? 'yolo'
      : 'manual';
  return {
    initialAppState: {
      model: input.cliOptions.model ?? '',
      workDir: input.workDir,
      additionalDirs: [...(input.additionalDirs ?? [])],
      sessionId: '',
      permissionMode,
      planMode: input.cliOptions.plan,
      agentProfile: input.agentProfile,
      agentFiles: input.cliOptions.agentFiles,
      inputMode: 'prompt',
      thinkingEffort: input.cliOptions.thinking ?? 'off',
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      isCompacting: false,
      isReplaying: false,
      streamingPhase: 'idle',
      streamingStartTime: 0,
      stepRetry: null,
      theme: input.tuiConfig.theme,
      busySubmit: input.tuiConfig.busySubmit ?? 'send_now',
      mouse: input.tuiConfig.mouse ?? true,
      screenMode: input.tuiConfig.screenMode ?? 'main',
      showThinking: input.tuiConfig.showThinking ?? true,
      showTimestamps: input.tuiConfig.showTimestamps ?? false,
      version: input.version,
      editorCommand: input.tuiConfig.editorCommand,
      disablePasteBurst: input.tuiConfig.disablePasteBurst,
      renderLatex: input.tuiConfig.renderLatex,
      cacheExpiryHint: input.tuiConfig.cacheExpiryHint,
      notifications: input.tuiConfig.notifications,
      statusLine: input.tuiConfig.statusLine,
      availableModels: {},
      availableProviders: {},
      sessionTitle: null,
      goal: null,
      mcpServersSummary: null,
    },
    startup: {
      sessionFlag: input.cliOptions.session,
      continueLast: input.cliOptions.continue,
      yolo: input.cliOptions.yolo,
      auto: input.cliOptions.auto,
      plan: input.cliOptions.plan,
      model: input.cliOptions.model,
      thinking: input.cliOptions.thinking,
      agentProfile: input.agentProfile,
      agentFiles: input.cliOptions.agentFiles,
      startupNotice: input.startupNotice,
    },
  };
}
