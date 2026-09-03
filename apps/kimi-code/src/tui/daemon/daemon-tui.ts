import { Text, TuiAltScreen } from '@moonshot-ai/pi-tui';
import type { PermissionMode } from '@moonshot-ai/kimi-code-sdk';
import type { QuestionResponse } from '@moonshot-ai/protocol';

import { SessionController } from '@kiki/session-core/session/sessionController';
import type {
  ApprovalBlock,
  Block,
  QuestionBlock,
  SessionViewState,
} from '@kiki/session-core/session/transcript/types';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { WelcomeComponent } from '#/tui/components/chrome/welcome';
import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import { QuestionDialogComponent } from '#/tui/components/dialogs/question-dialog';
import { SessionPickerComponent, type SessionRow } from '#/tui/components/dialogs/session-picker';
import type { TuiConfig } from '#/tui/config';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { adaptApprovalRequest } from '#/tui/reverse-rpc/approval/adapter';
import type {
  ApprovalPanelData,
  QuestionPanelData,
  QuestionPanelResponse,
} from '#/tui/reverse-rpc/types';
import { currentTheme } from '#/tui/theme';
import { createTUIState, type TUIState } from '#/tui/tui-state';
import type { AppState, KimiTUIOptions } from '#/tui/types';
import { formatErrorMessage } from '#/tui/utils/event-payload';

import { DaemonClient } from './client';
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
  public exitOpenUrl: string | undefined;
  public exitForegroundTask: ((exitCode: number) => Promise<void>) | undefined;

  private readonly client: DaemonClient;
  private readonly socket: DaemonSocket;
  private readonly renderer: DaemonTranscriptRenderer;
  private readonly startup: DaemonTUIStartupInput;
  private controller: SessionController | undefined;
  private mainControllerDispose: (() => void) | undefined;
  private focusedControllerDispose: (() => void) | undefined;
  private activeInteractionId: string | undefined;
  private focusedAgentId = 'main';
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
  }

  async start(): Promise<void> {
    this.state.ui.start();
    this.socket.connect();
    this.state.transcriptContainer.addChild(new WelcomeComponent(this.state.appState));
    this.state.editorContainer.addChild(this.state.editor);
    this.state.ui.setFocus(this.state.editor);
    this.mountFooter();
    if (this.startup.startupNotice !== undefined) this.showStatus(this.startup.startupNotice);
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
    this.focusedControllerDispose?.();
    this.focusedControllerDispose = undefined;
    this.mainControllerDispose?.();
    this.mainControllerDispose = undefined;
    this.controller?.close();
    this.controller = undefined;
    this.renderer.dispose();
    this.socket.close();
    await this.client.close();
    this.state.footer.dispose();
    await this.state.terminal.drainInput();
    this.state.ui.stop();
  }

  private buildLayout(): void {
    if (this.state.ui instanceof TuiAltScreen) return;
    this.state.ui.clear();
    this.state.ui.addChild(this.state.transcriptContainer);
    this.state.ui.addChild(this.state.activityContainer);
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
    this.state.editor.onSubmit = (text) => {
      void this.handleInput(text).catch((error: unknown) => {
        this.showStatus(formatErrorMessage(error), 'error');
      });
    };
    this.state.editor.onCtrlC = () => {
      void this.stop();
    };
    this.state.editor.onCtrlD = () => {
      void this.stop();
    };
    this.state.editor.onInputModeChange = (mode) => {
      this.setAppState({ inputMode: mode });
    };
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
    if (!this.startup.cliOptions.continue) return;
    const sessions = await this.client.listSessions();
    const existing = sessions.items.find((item) => item.cwd === this.startup.workDir);
    if (existing === undefined) {
      await this.createSession();
    } else {
      await this.openSession(existing.id);
    }
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
  }

  private renderSession(view: SessionViewState): void {
    if (this.focusedAgentId === 'main') this.renderer.sync(view.blocks);
    this.setAppState({
      sessionId: view.sessionId,
      model: view.model ?? this.state.appState.model,
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
      sessionTitle: view.session?.title ?? null,
      goal: view.goal,
    });
    this.syncInteractionBlocks(view.blocks);
  }

  private async handleInput(raw: string): Promise<void> {
    const text = raw.trim();
    if (text === '') return;
    if (this.state.editor.inputMode === 'bash') {
      this.state.editor.setInputMode('prompt');
      const controller = await this.ensureSession();
      await this.client.klient.session(controller.sessionId).agent('main').runShellCommand({
        command: raw,
      });
      return;
    }
    if (text.startsWith('/')) {
      await this.handleSlash(text);
      return;
    }
    const controller = await this.ensureSession();
    await controller.sendPrompt({
      text: raw,
      profile: this.state.appState.agentProfile,
      model: this.startup.cliOptions.model,
      thinking: this.startup.cliOptions.thinking,
      permissionMode: this.state.appState.permissionMode,
      planMode: this.state.appState.planMode,
      swarmMode: this.state.appState.swarmMode,
    });
  }

  private async handleSlash(text: string): Promise<void> {
    const [token = '', ...rest] = text.slice(1).split(/\s+/u);
    const args = rest.join(' ');
    switch (token) {
      case 'quit':
      case 'exit':
        await this.stop();
        return;
      case 'sessions':
      case 'resume':
        await this.showSessionPicker();
        return;
      case 'new':
      case 'clear':
        await this.createSession();
        return;
      case 'agent':
        if (args !== '') this.setAppState({ agentProfile: args });
        return;
      case 'model': {
        if (args === '') return;
        const controller = await this.ensureSession();
        const result = await this.client.setModel(controller.sessionId, args);
        this.setAppState({ model: result.model });
        return;
      }
      case 'permission': {
        if (args !== 'manual' && args !== 'yolo' && args !== 'auto') return;
        const controller = await this.ensureSession();
        await this.client.setPermission(controller.sessionId, args);
        this.setAppState({ permissionMode: args });
        return;
      }
      case 'agents': {
        const controller = await this.ensureSession();
        const agents = await this.client.klient.session(controller.sessionId).agents();
        this.showStatus(Object.keys(agents).join('  '));
        return;
      }
      case 'agent-transcript':
        await this.openAgentTranscript(args === '' ? 'main' : args);
        return;
      default: {
        const controller = await this.ensureSession();
        try {
          await this.client.runCommand(controller.sessionId, token, args === '' ? undefined : args);
        } catch {
          this.showStatus(`Command is unavailable in daemon mode: /${token}`, 'error');
        }
      }
    }
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

  private async showSessionPicker(): Promise<void> {
    const page = await this.client.listSessions();
    const rows = page.items.map(sessionRow);
    const picker = new SessionPickerComponent({
      sessions: rows,
      loading: false,
      currentSessionId: this.controller?.sessionId ?? '',
      scope: 'all',
      onSelect: (row) => {
        this.restoreEditor();
        void this.openSession(row.id);
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
    });
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
      const decision =
        response.response === 'approved' || response.response === 'approved_for_session'
          ? 'approved'
          : response.response;
      void this.client
        .resolveApproval(this.controller!.sessionId, block.request.approval_id, {
          decision,
          scope: response.response === 'approved_for_session' ? 'session' : undefined,
          feedback: response.feedback,
          selected_label: response.selected_label,
          selected_option_id: response.selected_option_id,
        })
        .then(() => {
          this.activeInteractionId = undefined;
          this.restoreEditor();
          return this.controller?.resync();
        });
    });
    this.mountEditorReplacement(panel);
  }

  private showQuestion(block: QuestionBlock): void {
    const dialog = new QuestionDialogComponent(
      { data: questionPanelData(block) },
      (response) => {
        const request =
          response.answers.length === 0
            ? this.client.dismissQuestion(this.controller!.sessionId, block.request.question_id)
            : this.client.resolveQuestion(this.controller!.sessionId, block.request.question_id, {
                answers: questionAnswersFromPanel(block, response),
                method: response.method,
              });
        void request.then(() => {
          this.activeInteractionId = undefined;
          this.restoreEditor();
          return this.controller?.resync();
        });
      },
    );
    this.mountEditorReplacement(dialog);
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

function questionPanelData(block: QuestionBlock): QuestionPanelData {
  return {
    id: block.request.question_id,
    tool_call_id: block.request.tool_call_id ?? block.request.question_id,
    questions: block.request.questions.map((question) => ({
      question: question.question,
      header: question.header,
      body: question.body,
      multi_select: question.multi_select ?? false,
      other_label: question.other_label,
      other_description: question.other_description,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

export function questionAnswersFromPanel(
  block: QuestionBlock,
  response: QuestionPanelResponse,
): QuestionResponse['answers'] {
  const answers: QuestionResponse['answers'] = {};
  for (const [index, question] of block.request.questions.entries()) {
    const answer = response.answers[index];
    if (answer === undefined || answer === '') {
      answers[question.id] = { kind: 'skipped' };
      continue;
    }
    if (question.multi_select === true) {
      const values = answer.split(', ');
      const optionIds = question.options
        .filter((option) => values.includes(option.label))
        .map((option) => option.id);
      const other = values.filter(
        (value) => !question.options.some((option) => option.label === value),
      );
      answers[question.id] =
        other.length > 0
          ? { kind: 'multi_with_other', option_ids: optionIds, other_text: other.join(', ') }
          : { kind: 'multi', option_ids: optionIds };
      continue;
    }
    const option = question.options.find((candidate) => candidate.label === answer);
    answers[question.id] =
      option === undefined
        ? { kind: 'other', text: answer }
        : { kind: 'single', option_id: option.id };
  }
  return answers;
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
