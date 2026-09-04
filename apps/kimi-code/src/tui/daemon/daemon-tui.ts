import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

import { Text, TuiAltScreen } from '@moonshot-ai/pi-tui';
import { resolveAgentPath, type PermissionMode } from '@moonshot-ai/kimi-code-sdk';
import type { UpdateSessionProfileRequest } from '@moonshot-ai/protocol';

import { API_CODES, ApiError } from '@kiki/session-core/transport';
import { SessionController } from '@kiki/session-core/session/sessionController';
import type {
  ApprovalBlock,
  Block,
  QuestionBlock,
  SessionViewState,
} from '@kiki/session-core/session/transcript/types';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import {
  ApprovalPanelComponent,
  type ApprovalPanelResponse,
} from '#/tui/components/dialogs/approval-panel';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from '#/tui/components/dialogs/session-picker';
import { FileMentionProvider } from '#/tui/components/editor/file-mention-provider';
import type { TuiConfig } from '#/tui/config';
import {
  CTRL_C_HINT,
  CTRL_D_HINT,
  EXIT_CONFIRM_WINDOW_MS,
} from '#/tui/constant/kimi-tui';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { adaptApprovalRequest } from '#/tui/interactions/approval-adapter';
import {
  adaptQuestionRequest,
  adaptQuestionResponse,
} from '#/tui/interactions/question-adapter';
import type { ApprovalPanelData, QuestionPanelResponse } from '#/tui/interactions/types';
import { currentTheme } from '#/tui/theme';
import { createTUIState, type TUIState } from '#/tui/tui-state';
import { parseGoalCommand } from '#/tui/commands/goal-parse';
import type { AppState, KimiTUIOptions } from '#/tui/types';
import { formatErrorMessage } from '#/tui/utils/event-payload';
import { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';
import { extractInlineSkillActivations } from '#/tui/utils/inline-skill-tokens';
import { readClipboardMedia } from '#/utils/clipboard/clipboard-image';
import { parseImageMeta } from '#/utils/image/image-mime';
import { openUrl } from '#/utils/open-url';
import { loadPluginMarketplace } from '#/utils/plugin-marketplace';

import {
  prepareDaemonPrompt,
  type DaemonFileAttachment,
} from './attachments';
import { DaemonClient } from './client';
import {
  daemonAutocompleteCommands,
  daemonCommandHelp,
  parseDaemonSlashInput,
  resolveDaemonCommand,
  validateDaemonCommandArgs,
  type DaemonSkillCommand,
} from './commands';
import type { DaemonConnection } from './discovery';
import { DaemonSocket } from './socket';
import { DaemonTranscriptRenderer } from './transcript-renderer';

export interface DaemonTUIStartupInput {
  readonly cliOptions: {
    readonly session?: string;
    readonly continue: boolean;
    readonly yolo: boolean;
    readonly auto: boolean;
    readonly plan: boolean;
    readonly model?: string;
    readonly thinking?: string;
    readonly agentFiles: readonly string[];
    readonly skillsDirs: readonly string[];
  };
  readonly agentProfile?: string;
  readonly additionalDirs?: readonly string[];
  readonly tuiConfig: TuiConfig;
  readonly version: string;
  readonly workDir: string;
  readonly startupNotice?: string;
}

type SessionSummary = Awaited<ReturnType<DaemonClient['listSessions']>>['items'][number];

export class DaemonTUI {
  readonly state: TUIState;
  public onExit?: (exitCode?: number) => Promise<void>;

  private readonly client: DaemonClient;
  private readonly socket: DaemonSocket;
  private readonly renderer: DaemonTranscriptRenderer;
  private readonly startup: DaemonTUIStartupInput;
  private controller: SessionController | undefined;
  private mainControllerDispose: (() => void) | undefined;
  private focusedControllerDispose: (() => void) | undefined;
  private activeInteractionId: string | undefined;
  private readonly skillCommands = new Map<string, DaemonSkillCommand>();
  private readonly agentProfileCommands = new Map<string, string>();
  private readonly imageAttachments = new ImageAttachmentStore();
  private readonly fileAttachments = new Map<number, DaemonFileAttachment>();
  private nextFileAttachmentId = 1;
  private focusedAgentId = 'main';
  private pendingExit:
    | { readonly kind: 'ctrl-c' | 'ctrl-d'; readonly timer: ReturnType<typeof setTimeout> }
    | undefined;
  private startupOverridesPending = true;
  private todoExpanded = false;
  private restoreExplicitConfig: (() => Promise<void>) | undefined;
  private stopped = false;

  constructor(connection: DaemonConnection, startup: DaemonTUIStartupInput) {
    this.startup = startup;
    this.state = createTUIState(createOptions(startup));
    this.client = new DaemonClient(connection);
    this.socket = new DaemonSocket({
      ...connection,
      events: {
        onStatus: (status) => {
          if (status === 'closed') this.controller?.handleWsDrop();
        },
        onFrame: (frame) => this.controller?.handleFrame(frame),
        onTranscript: (event, generation) => this.controller?.handleTranscript(event, generation),
        onResyncRequired: (payload) => this.controller?.handleResyncRequired(payload),
        onSubscribeAck: (_accepted, rejected, reconnected, generation) => {
          if (rejected.includes(this.controller?.sessionId ?? '')) {
            this.controller?.handleSubscribeRejected(generation);
          } else if (reconnected) {
            this.controller?.handleReconnectAck();
          }
        },
      },
    });
    this.renderer = new DaemonTranscriptRenderer(
      this.state.transcriptContainer,
      this.state.ui,
      startup.workDir,
    );
    this.buildLayout();
    this.installEditor();
    this.setupAutocomplete();
  }

  async start(): Promise<void> {
    this.state.ui.start();
    this.socket.connect();
    this.state.transcriptContainer.addChild(new WelcomeComponent(this.state.appState));
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.state.todoPanelContainer.addChild(this.state.todoPanel);
    this.mountFooter();
    if (this.startup.startupNotice !== undefined) this.showStatus(this.startup.startupNotice);
    await this.configureExplicitSources();
    await this.refreshAgentCommands();
    await this.initializeSession();
  }

  async close(): Promise<void> {
    await this.dispose();
  }

  async stop(exitCode = 0): Promise<void> {
    await this.dispose();
    await this.onExit?.(exitCode);
  }

  getCurrentSessionId(): string {
    return this.controller?.sessionId ?? '';
  }

  hasSessionContent(): boolean {
    return (this.controller?.getState().blocks.length ?? 0) > 0;
  }

  private async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    let failure: Error | undefined;
    const cleanup = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    };
    await cleanup(() => {
      this.clearPendingExit();
    });
    await cleanup(() => this.focusedControllerDispose?.());
    this.focusedControllerDispose = undefined;
    await cleanup(() => this.mainControllerDispose?.());
    this.mainControllerDispose = undefined;
    await cleanup(() => this.controller?.close());
    this.controller = undefined;
    await cleanup(() => {
      this.renderer.dispose();
    });
    await cleanup(() => {
      this.socket.close();
    });
    await cleanup(() => this.restoreExplicitConfig?.());
    this.restoreExplicitConfig = undefined;
    await cleanup(() => this.client.close());
    await cleanup(() => {
      this.state.footer.dispose();
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
    const wrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    wrap.addChild(this.state.footer);
    if (this.state.dockContainer !== undefined) {
      this.state.dockContainer.addChild(wrap, { shrink: 1, minSize: 1 });
    } else {
      this.state.ui.addChild(wrap);
    }
  }

  private installEditor(): void {
    const editor = this.state.editor;
    editor.onSubmit = (text) => {
      this.clearPendingExit();
      void this.handleInput(text).catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
    };
    editor.onCtrlC = () => {
      void this.handleInterrupt('ctrl-c');
    };
    editor.onCtrlD = () => {
      this.confirmExit('ctrl-d');
    };
    editor.onEscape = () => {
      this.clearPendingExit();
      if (this.controller?.getState().busy === true) void this.abortActivePrompt();
    };
    editor.onNonEscapeInput = () => {
      this.clearPendingExit();
    };
    editor.onShiftTab = () => {
      void this.applyPlanMode(!this.state.appState.planMode).catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
    };
    editor.onToggleToolExpand = () => {
      const expanded = !this.state.toolOutputExpanded;
      this.state.toolOutputExpanded = expanded;
      this.renderer.setExpanded(expanded);
    };
    editor.onOpenExternalEditor = () => {
      this.showStatus('External editor is disabled in daemon TUI.', 'error');
    };
    editor.onCtrlS = () => {
      this.showStatus('Prompt steering shortcut is disabled in daemon TUI.', 'error');
    };
    editor.onCtrlB = () => {
      if (this.controller?.getState().busy !== true) return false;
      this.showStatus('Backgrounding the active turn is disabled in daemon TUI.', 'error');
      return true;
    };
    editor.onToggleTodoExpand = () => {
      if (!this.state.todoPanel.hasOverflow()) return false;
      this.todoExpanded = !this.todoExpanded;
      this.state.todoPanel.setExpanded(this.todoExpanded);
      this.state.ui.requestRender(true);
      return true;
    };
    editor.onUndo = () => {
      void this.undoLastTurn().catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
    };
    editor.onTextPaste = () => {
      this.clearPendingExit();
    };
    editor.onPasteImage = async () => {
      try {
        return await this.handleClipboardPaste();
      } catch (error) {
        this.showStatus(`Attachment upload failed: ${formatErrorMessage(error)}`, 'error');
        return true;
      }
    };
    editor.onInputModeChange = (mode) => {
      this.setAppState({ inputMode: mode });
    };
    editor.onRecall = (entry) => {
      if (entry.startsWith('!')) {
        editor.setInputMode('bash');
        return entry.slice(1);
      }
      editor.setInputMode('prompt');
      return undefined;
    };
  }

  private async handleClipboardPaste(): Promise<boolean> {
    const media = await readClipboardMedia();
    if (media === null) return false;
    if (media.kind === 'image') {
      const dimensions = parseImageMeta(media.bytes);
      if (dimensions === null) return false;
      const upload = await this.client.klient.global.files.save({
        data: media.bytes,
        filename: `clipboard.${imageExtension(media.mimeType)}`,
        mimeType: media.mimeType,
      });
      const attachment = this.imageAttachments.addImage(
        media.bytes,
        media.mimeType,
        dimensions.width,
        dimensions.height,
        undefined,
        upload.id,
      );
      this.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
      this.state.ui.requestRender();
      return true;
    }
    const bytes = await readFile(media.sourcePath);
    const upload = await this.client.klient.global.files.save({
      data: bytes,
      filename: media.filename,
      mimeType: media.mimeType,
    });
    const attachment = this.imageAttachments.addVideo(
      media.mimeType,
      media.sourcePath,
      media.filename,
    );
    this.imageAttachments.completeVideo(attachment, { fileId: upload.id });
    this.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.state.ui.requestRender();
    return true;
  }

  private async handleInterrupt(kind: 'ctrl-c'): Promise<void> {
    if (this.controller?.getState().busy === true) {
      this.clearPendingExit();
      if (this.state.editor.getText().length > 0) {
        this.state.editor.setText('');
        return;
      }
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

  private confirmExit(kind: 'ctrl-c' | 'ctrl-d'): void {
    if (this.pendingExit?.kind === kind) {
      this.clearPendingExit();
      void this.stop();
      return;
    }
    if (kind === 'ctrl-c' && this.state.editor.getText().length > 0) {
      this.state.editor.setText('');
    }
    this.clearPendingExit();
    const timer = setTimeout(() => {
      if (this.pendingExit?.timer !== timer) return;
      this.clearPendingExit();
      this.state.ui.requestRender();
    }, EXIT_CONFIRM_WINDOW_MS);
    this.pendingExit = { kind, timer };
    this.state.footer.setTransientHint(kind === 'ctrl-c' ? CTRL_C_HINT : CTRL_D_HINT);
    this.state.ui.requestRender();
  }

  private clearPendingExit(): void {
    if (this.pendingExit === undefined) return;
    clearTimeout(this.pendingExit.timer);
    this.pendingExit = undefined;
    this.state.footer.setTransientHint(null);
  }

  private async configureExplicitSources(): Promise<void> {
    const skillDirs = this.startup.cliOptions.skillsDirs.map((path) =>
      resolve(this.startup.workDir, path),
    );
    const agentDirs = this.startup.cliOptions.agentFiles.map((path) =>
      dirname(resolveAgentPath(path, this.startup.workDir, homedir())),
    );
    if (skillDirs.length === 0 && agentDirs.length === 0) return;
    const config = this.client.klient.global.config;
    const [previousSkillDirs, previousAgentDirs] = await Promise.all([
      config.get<readonly string[]>('extraSkillDirs'),
      config.get<readonly string[]>('extraAgentDirs'),
    ]);
    this.restoreExplicitConfig = async () => {
      await config.replaceSections({
        sections: {
          extraSkillDirs: previousSkillDirs,
          extraAgentDirs: previousAgentDirs,
        },
      });
      await config.reload();
    };
    await config.replaceSections({
      sections: {
        extraSkillDirs: uniquePaths([...(previousSkillDirs ?? []), ...skillDirs]),
        extraAgentDirs: uniquePaths([...(previousAgentDirs ?? []), ...agentDirs]),
      },
    });
    await config.reload();
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
        null,
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
    for (const skill of response.skills) {
      if (
        skill.type !== undefined &&
        skill.type !== 'prompt' &&
        skill.type !== 'inline' &&
        skill.type !== 'flow'
      ) {
        continue;
      }
      const commandName = skill.source === 'builtin' ? skill.name : `skill:${skill.name}`;
      this.skillCommands.set(commandName.toLowerCase(), {
        commandName,
        name: skill.name,
        description: skill.description,
      });
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
    if (this.controller !== undefined) return this.controller;
    await this.createSession();
    return this.controller!;
  }

  private async createSession(): Promise<void> {
    const session = await this.client.createSession({
      workDir: this.startup.workDir,
      additionalDirs: this.startup.additionalDirs,
    });
    await this.openSession(session.id);
  }

  private async openSession(sessionId: string): Promise<void> {
    this.focusedControllerDispose?.();
    this.focusedControllerDispose = undefined;
    this.mainControllerDispose?.();
    this.controller?.close();
    this.focusedAgentId = 'main';
    const controller = new SessionController(this.client, this.socket, sessionId);
    this.controller = controller;
    this.mainControllerDispose = controller.subscribe(() => {
      this.renderSession(controller.getState());
    });
    await controller.open();
    this.renderSession(controller.getState());
    await this.applyStartupOverrides(controller);
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
    if (this.focusedAgentId === 'main') this.renderer.sync(view.blocks);
    this.setAppState({
      sessionId: view.sessionId,
      model: view.model ?? this.state.appState.model,
      agentProfile: view.profile ?? this.state.appState.agentProfile,
      permissionMode: view.permissionMode ?? this.state.appState.permissionMode,
      planMode: view.planMode,
      swarmMode: view.swarmMode,
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
    this.renderActivityState(view);
    this.syncInteractionBlocks(view.blocks);
  }

  private renderActivityState(view: SessionViewState): void {
    let message: string | undefined;
    let tone: 'normal' | 'error' = 'normal';
    if (view.resyncFailed) {
      message = 'Session resync failed. Run /reload to retry.';
      tone = 'error';
    } else if (view.resyncing) {
      message = `Resyncing session (attempt ${String(view.resyncAttempt)})…`;
    } else if (view.turnRetry !== undefined) {
      message = `Retrying attempt ${String(view.turnRetry.failedAttempt + 1)}/${String(view.turnRetry.maxAttempts)} in ${String(view.turnRetry.delayMs)}ms`;
    } else if (view.busy) {
      const runningTasks = view.tasks.filter((task) => task.status === 'running').length;
      message = runningTasks > 0 ? `Working · ${String(runningTasks)} tasks running` : 'Working…';
    }
    if (message === undefined) {
      this.state.activityContainer.clear();
      this.state.ui.requestRender();
      return;
    }
    this.showStatus(message, tone);
  }

  private async handleInput(raw: string): Promise<void> {
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
    await this.sendPrompt(raw);
  }

  private async sendPrompt(text: string, profile?: string): Promise<void> {
    const controller = await this.ensureSession();
    const prepared = await prepareDaemonPrompt(text, this.imageAttachments, this.fileAttachments);
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
        await this.client.klient.session(controller.sessionId).agent('main').promptWithSkills({
          input: prepared?.engineContent ?? [{ type: 'text', text }],
          skills: inlineSkills.map((skill) => ({ name: skill.skillName })),
        });
        await controller.resync();
        return;
      }
    }
    await controller.sendPrompt({
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
      swarmMode: this.state.appState.swarmMode,
    });
  }

  private async handleSlash(text: string): Promise<void> {
    const { token, rawToken, args } = parseDaemonSlashInput(text);
    const resolved = resolveDaemonCommand(token, args);
    if (resolved === undefined) {
      const skill = this.skillCommands.get(token);
      if (skill !== undefined) {
        const controller = await this.ensureSession();
        await this.client.activateSkill(
          controller.sessionId,
          skill.name,
          args === '' ? undefined : args,
        );
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
      this.showStatus(`Unknown daemon TUI command: /${rawToken}`, 'error');
      return;
    }
    if ('status' in resolved) {
      this.showStatus(`Command is disabled in daemon TUI: /${resolved.name}`, 'error');
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
      case 'swarm':
        await this.applySwarmMode(!this.state.appState.swarmMode);
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
      case 'help':
        this.showStatus(daemonCommandHelp());
        return;
      case 'version':
        this.showStatus(this.state.appState.version);
        return;
    }
  }

  private async applyModel(model: string): Promise<void> {
    const models = await this.client.listModels();
    if (!models.items.some((item) => item.model === model)) {
      throw new Error(`Model "${model}" was not found.`);
    }
    const controller = await this.ensureSession();
    const session = await this.client.setModel(controller.sessionId, model);
    controller.handleSessionRecord(session);
    this.setAppState({ model });
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

  private async applySwarmMode(swarmMode: boolean): Promise<void> {
    const controller = await this.ensureSession();
    const session = await this.client.setSwarmMode(controller.sessionId, swarmMode);
    controller.handleSessionRecord(session);
    this.setAppState({ swarmMode });
  }

  private async applyTitle(title: string): Promise<void> {
    const controller = await this.ensureSession();
    const session = await this.client.setTitle(controller.sessionId, title);
    controller.handleSessionRecord(session);
    this.setAppState({ sessionTitle: session.title });
  }

  private showSessionStatus(): void {
    const state = this.state.appState;
    this.showStatus(
      [
        `Session: ${state.sessionId === '' ? 'not started' : state.sessionId}`,
        `Model: ${state.model === '' ? 'not selected' : state.model}`,
        `Profile: ${state.agentProfile ?? 'default'}`,
        `Thinking: ${state.thinkingEffort}`,
        `Permission: ${state.permissionMode}`,
        `Plan: ${state.planMode ? 'on' : 'off'}`,
        `Swarm: ${state.swarmMode ? 'on' : 'off'}`,
      ].join('\n'),
    );
  }

  private async showUsage(): Promise<void> {
    const controller = await this.ensureSession();
    const usage = await this.client.klient.session(controller.sessionId).agent('main').getUsage();
    this.showStatus(JSON.stringify(usage, undefined, 2));
  }

  private async compactSession(instruction: string): Promise<void> {
    const controller = await this.ensureSession();
    const started = await this.client.klient
      .session(controller.sessionId)
      .agent('main')
      .compact(instruction === '' ? undefined : { instruction });
    this.showStatus(started ? 'Context compaction started.' : 'Context compaction is already running.');
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
      this.showStatus(await agent.getTaskOutput({ taskId, tail: 20_000 }));
      return;
    }
    if (args !== '') {
      this.showStatus(await agent.getTaskOutput({ taskId: args, tail: 20_000 }));
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
            this.showStatus(output);
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
    await this.openSession(fork.id);
  }

  private async handlePluginsCommand(args: string): Promise<void> {
    const plugins = this.client.klient.global.plugins;
    const [action, rest] = splitFirst(args);
    if (action === '') {
      const items = await plugins.list();
      this.showStatus(
        items
          .map((item) => `${item.id} · ${item.enabled ? 'enabled' : 'disabled'} · ${item.state}`)
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
      this.showStatus(
        [
          `Source: ${marketplace.source}`,
          ...marketplace.plugins.map((item) => item.displayName),
        ].join('\n'),
      );
      return;
    }
    if (action === 'install') {
      if (rest === '') throw new Error('/plugins install requires an explicit source.');
      await plugins.install(rest);
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
    await this.reloadDaemonState();
  }

  private async handleProviderCommand(args: string): Promise<void> {
    const providers = this.client.klient.global.kosong;
    const [action, rest] = splitFirst(args);
    if (action === '') {
      const items = await providers.listProviders();
      this.showStatus(
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
        throw new Error('/provider add requires an id and JSON configuration.');
      }
      await providers.addProvider(id, JSON.parse(json) as never);
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
    const flow = await this.client.klient.global.auth.startLogin(provider);
    if (flow.status === 'authenticated') {
      this.showStatus(`Authenticated with ${flow.provider}.`);
      return;
    }
    openUrl(flow.verification_uri_complete);
    this.showStatus(
      `Open ${flow.verification_uri} and enter code ${flow.user_code}. Run /reload after authentication completes.`,
    );
  }

  private async logout(provider: string | undefined): Promise<void> {
    const result = await this.client.klient.global.auth.logout(provider);
    this.showStatus(`Logged out from ${result.provider}.`);
  }

  private async showMcpStatus(): Promise<void> {
    const controller = await this.ensureSession();
    const servers = await this.client.klient
      .session(controller.sessionId)
      .agent('main')
      .getMcpServers();
    this.showStatus(
      servers.map((server) => `${server.name} · ${server.status}`).join('\n') || 'No MCP servers configured.',
    );
  }

  private async handleGoalCommand(args: string): Promise<void> {
    const parsed = parseGoalCommand(args);
    if (parsed.kind === 'error') throw new Error(parsed.message);
    if (parsed.kind === 'status') {
      this.showStatus(JSON.stringify(this.controller?.getState().goal ?? null, undefined, 2));
      return;
    }
    if (parsed.kind === 'next-add' || parsed.kind === 'next-manage') {
      throw new Error('Goal queue management is not available in daemon TUI.');
    }
    const controller = await this.ensureSession();
    const common = {
      permissionMode: this.state.appState.permissionMode,
      planMode: this.state.appState.planMode,
      swarmMode: this.state.appState.swarmMode,
    };
    if (parsed.kind === 'create') {
      await controller.sendPrompt({
        ...common,
        text: parsed.objective,
        goalObjective: parsed.objective,
      });
      return;
    }
    await controller.sendPrompt({
      ...common,
      text: `Goal ${parsed.kind}`,
      goalControl: parsed.kind,
    });
  }

  private async handleSettingsCommand(args: string): Promise<void> {
    const config = this.client.klient.global.config;
    const [domain, json] = splitFirst(args);
    if (domain === '') {
      this.showStatus(JSON.stringify(await config.getAll(), undefined, 2));
      return;
    }
    if (json === '') {
      this.showStatus(JSON.stringify(await config.get(domain), undefined, 2));
      return;
    }
    await config.replace({ domain, value: JSON.parse(json) });
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
    });
    const id = this.nextFileAttachmentId++;
    const attachment: DaemonFileAttachment = {
      id,
      fileId: upload.id,
      name,
      mediaType,
      size: data.byteLength,
      placeholder: `[file #${String(id)} ${name}]`,
    };
    this.fileAttachments.set(id, attachment);
    this.state.editor.insertTextAtCursor?.(`${attachment.placeholder} `);
    this.state.ui.requestRender();
  }

  private async showThinkingPicker(): Promise<void> {
    const models = await this.client.listModels();
    const model = models.items.find((item) => item.model === this.state.appState.model);
    if (model === undefined) throw new Error('Select a model before choosing thinking effort.');
    const supported = model.support_efforts ?? [];
    const efforts = [
      'off',
      ...(supported.length > 0
        ? supported
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
    const models = await this.client.listModels();
    const picker = new ChoicePickerComponent({
      title: 'Switch LLM model',
      options: models.items.map((item) => ({
        value: item.model,
        label: item.display_name ?? item.model,
        description: item.provider,
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
      swarmMode: session.agent_config.swarm_mode ?? this.state.appState.swarmMode,
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
    const picker = new ChoicePickerComponent({
      title: 'Select permission mode',
      options: [
        { value: 'manual', label: 'Manual' },
        { value: 'yolo', label: 'YOLO' },
        { value: 'auto', label: 'Auto' },
      ],
      currentValue: this.state.appState.permissionMode,
      onSelect: (mode) => {
        this.restoreEditor();
        void this.applyPermission(mode as PermissionMode).catch((error: unknown) => {
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
      this.renderer.sync(controller.getState().blocks);
      return;
    }
    const render = () => {
      this.renderer.sync(controller.getAgentState(agentId).blocks);
    };
    this.focusedControllerDispose = controller.subscribeAgent(agentId, render);
    render();
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
    const picker = new SessionPickerComponent({
      sessions: visibleRows(page.items),
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
      onCtrlC: () => {
        void this.stop();
      },
      onCtrlD: () => {
        void this.stop();
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
  }

  private syncInteractionBlocks(blocks: readonly Block[]): void {
    const interaction = blocks.find(
      (block): block is ApprovalBlock | QuestionBlock =>
        (block.kind === 'approval' && block.resolution === undefined) ||
        (block.kind === 'question' && block.outcome === undefined),
    );
    if (interaction === undefined) {
      if (this.activeInteractionId !== undefined) this.restoreEditor();
      this.activeInteractionId = undefined;
      return;
    }
    if (interaction.id === this.activeInteractionId) return;
    this.activeInteractionId = interaction.id;
    if (interaction.kind === 'approval') this.showApproval(interaction);
    else this.showQuestion(interaction);
  }

  private showApproval(block: ApprovalBlock): void {
    const panel = new ApprovalPanelComponent({ data: approvalPanelData(block) }, (response) => {
      void this.respondApproval(block, response).catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
    });
    this.mountEditorReplacement(panel);
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
      (response) => {
        void this.respondQuestion(block, response).catch((error: unknown) => {
          this.showStatus(formatErrorMessage(error), 'error');
        });
      },
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
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(component);
    this.state.ui.setFocus(component);
    this.state.ui.requestRender();
  }

  private restoreEditor(): void {
    this.state.editorContainer.clear();
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.state.ui.requestRender();
  }

  private showStatus(message: string, tone: 'normal' | 'error' = 'normal'): void {
    this.state.activityContainer.clear();
    this.state.activityContainer.addChild(
      new Text(tone === 'error' ? currentTheme.fg('error', message) : currentTheme.dim(message), 0, 0),
    );
    this.state.ui.requestRender();
  }

  private setAppState(patch: Partial<AppState>): void {
    Object.assign(this.state.appState, patch);
    this.state.footer.setState({ ...this.state.appState });
    this.state.ui.requestRender();
  }
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
    display: request.tool_input_display,
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

function splitFirst(value: string): readonly [string, string] {
  const trimmed = value.trim();
  const boundary = trimmed.search(/\s/u);
  return boundary === -1
    ? [trimmed, '']
    : [trimmed.slice(0, boundary), trimmed.slice(boundary).trim()];
}

function normalizedPath(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/').replace(/\/$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Map(paths.map((path) => [normalizedPath(path), path])).values()];
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
      swarmMode: false,
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
