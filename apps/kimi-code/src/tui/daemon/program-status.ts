import { randomBytes } from 'node:crypto';
import type { SessionViewState } from '@kiki/session-core/session/transcript/types';
import { ProgramStatusReporter, type ProgramStatusReport } from '#/tui/utils/program-status';
import { TERMINAL_FOCUS_IN, TERMINAL_FOCUS_OUT } from '#/tui/constant/terminal';
import { PROGRAM_STATUS_PRESENCE_RETRY_MS, PROGRAM_STATUS_PRESENCE_RETRY_MAX_MS } from '#/tui/constant/program-status';
import type { DaemonClient, SessionAccessConfig, SessionAccessPresence } from './client';
import type { DaemonConnection } from './discovery';

const holderId = randomBytes(16).toString('base64url');

export class DaemonProgramStatus {
  readonly reporter: ProgramStatusReporter;
  private readonly port: string | undefined;
  private config: SessionAccessConfig | undefined;
  private presence: SessionAccessPresence | undefined;
  private presenceUsed = false;
  private presenceRetry: ReturnType<typeof setTimeout> | undefined;
  private presenceFailures = 0;
  private sessionId: string | undefined;
  private sessionGeneration = 0;
  private sessionSwitch = Promise.resolve();
  private pendingSwitches = 0;
  private view: SessionViewState | undefined;
  private done = false;
  private authRequired: string | undefined;
  private stopped = false;
  private teardown: Promise<void> | undefined;

  constructor(
    private readonly client: Pick<DaemonClient, 'getSessionAccess' | 'openSessionAccessPresence' | 'requestSessionAccessTicket' | 'releaseSessionAccess'>,
    connection: DaemonConnection,
    write: (sequence: string) => void,
    private readonly focused: () => boolean,
    private readonly ephemeral: (sessionId: string) => boolean,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const url = new URL(connection.url);
    if (connection.localOwner === true && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !env['SSH_CONNECTION'] && !env['SSH_TTY'] && !env['SSH_CLIENT']) {
      this.port = url.port || (url.protocol === 'https:' ? '443' : '80');
    }
    this.reporter = new ProgramStatusReporter(write, (challenge) => this.ticket(challenge), Date.now, () => this.canRequestTicket());
  }

  start(): void {
    this.reporter.start();
    void this.refreshConfig();
  }

  input(data: string): ReturnType<ProgramStatusReporter['handleInput']> {
    const result = this.reporter.handleInput(data);
    if (result !== undefined && 'consume' in result) return result;
    const input = result?.data ?? data;
    if (input !== TERMINAL_FOCUS_OUT) {
      this.done = false;
      if (input === TERMINAL_FOCUS_IN || this.view !== undefined) this.report();
    }
    return result;
  }

  switchSession(sessionId: string): Promise<void> {
    this.sessionGeneration += 1;
    this.reporter.discardQueuedTicket();
    this.pendingSwitches += 1;
    const operation = this.sessionSwitch.then(async () => {
      if (this.presenceUsed && this.config?.enabled !== false && this.sessionId !== undefined) {
        try {
          await this.client.releaseSessionAccess(holderId, this.sessionId, AbortSignal.timeout(500));
        } catch (error) {
          this.closePresence();
          throw error;
        }
      }
      this.sessionId = sessionId;
      this.view = undefined;
      this.done = false;
      this.authRequired = undefined;
    }).finally(() => { this.pendingSwitches -= 1; });
    this.sessionSwitch = operation.catch(() => {});
    return operation;
  }

  update(view: SessionViewState): void {
    if (this.pendingSwitches > 0 || (this.sessionId !== undefined && view.sessionId !== this.sessionId)) return;
    const wasBusy = this.view?.busy === true;
    const completed = view.turnTail?.state === 'completed' && view.turnTail.turnId !== this.view?.turnTail?.turnId;
    if (wasBusy && !view.busy) this.done = completed && !this.focused();
    if (view.busy) {
      this.done = false;
      if (!wasBusy) this.authRequired = undefined;
    }
    this.view = view;
    this.report();
  }

  requireAuth(message: string | undefined): void {
    this.authRequired = message;
    this.report();
  }

  dispose(): Promise<void> {
    this.teardown ??= this.finishDispose();
    return this.teardown;
  }

  private async finishDispose(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.presenceRetry);
    this.presenceRetry = undefined;
    if (this.presenceUsed) {
      await this.client.releaseSessionAccess(holderId, undefined, AbortSignal.timeout(500)).catch(() => {});
    }
    this.closePresence();
    this.reporter.clear();
  }

  async refreshConfig(): Promise<void> {
    if (this.port === undefined || this.stopped) return;
    const previous = this.config;
    const config = await this.client.getSessionAccess().catch(() => undefined);
    if (this.stopped) return;
    this.config = config;
    const changed = previous?.server_id !== config?.server_id || previous?.enabled !== config?.enabled || previous?.terminal_handoff !== config?.terminal_handoff;
    if (changed) {
      this.sessionGeneration += 1;
      this.reporter.discardQueuedTicket();
      this.closePresence();
    }
    if (this.presenceUsed && this.enabled() && this.presence === undefined) this.openPresence();
    this.report();
  }

  private enabled(): boolean {
    return this.port !== undefined && this.config?.enabled === true && this.config.terminal_handoff;
  }

  private canRequestTicket(): boolean {
    return !this.stopped && this.pendingSwitches === 0 && this.enabled() && this.sessionId !== undefined
      && this.view?.sessionId === this.sessionId && this.view.loaded && !this.ephemeral(this.sessionId) && this.view.session?.ephemeral !== true;
  }

  private report(): void {
    if (this.pendingSwitches > 0) return;
    const view = this.view;
    const approval = view?.blocks.find((block) => block.kind === 'approval' && block.resolution === undefined);
    const question = view?.blocks.find((block) => block.kind === 'question' && block.outcome === undefined);
    let status: ProgramStatusReport;
    if (approval?.kind === 'approval' || view?.pendingInteraction === 'approval') {
      status = { state: 'blocked', kind: 'permission', msg: approval?.kind === 'approval' ? `${approval.request.tool_name}: ${approval.request.action}` : 'Permission approval required' };
    } else if (question?.kind === 'question' || view?.pendingInteraction === 'question') {
      status = { state: 'blocked', kind: 'question', msg: question?.kind === 'question' ? question.request.questions.map((item) => item.question).join(' ') : 'Answer a question to continue' };
    } else if (this.authRequired !== undefined) {
      status = { state: 'blocked', kind: 'auth', msg: this.authRequired };
    } else if (view?.busy || view?.session?.main_turn_active) {
      status = { state: 'working' };
    } else if (view?.turnTail?.state === 'failed' || view?.session?.last_turn_reason === 'failed') {
      status = { state: 'error', msg: view.turnTail?.error ?? 'Turn failed' };
    } else {
      status = { state: this.done ? 'done' : 'idle' };
    }
    this.reporter.update({
      ...status,
      title: view?.session?.title ?? undefined,
      handoff: this.enabled() ? {
        session: this.sessionId !== undefined && !this.ephemeral(this.sessionId) && view?.session?.ephemeral !== true ? this.sessionId : undefined,
        port: this.port!,
        server: this.config!.server_id,
      } : undefined,
    });
  }

  private closePresence(): void {
    clearTimeout(this.presenceRetry);
    this.presenceRetry = undefined;
    const presence = this.presence;
    this.presence = undefined;
    presence?.close();
  }

  private openPresence(): SessionAccessPresence {
    clearTimeout(this.presenceRetry);
    this.presenceRetry = undefined;
    this.presenceUsed = true;
    const presence = this.client.openSessionAccessPresence(holderId);
    this.presence = presence;
    void presence.ready.then(() => { this.presenceFailures = 0; }, () => {});
    void presence.closed.then(() => {
      if (this.presence !== presence) return;
      this.presence = undefined;
      if (this.stopped || !this.enabled()) return;
      const delay = Math.min(PROGRAM_STATUS_PRESENCE_RETRY_MAX_MS, PROGRAM_STATUS_PRESENCE_RETRY_MS * 2 ** this.presenceFailures++);
      this.presenceRetry = setTimeout(() => { this.openPresence(); }, delay);
      this.presenceRetry.unref();
    });
    return presence;
  }

  private async ticket(challenge: string): Promise<string | undefined> {
    const sessionId = this.sessionId;
    const generation = this.sessionGeneration;
    if (!this.canRequestTicket() || sessionId === undefined) return undefined;
    const presence = this.presence ?? this.openPresence();
    await presence.ready;
    if (this.stopped || this.sessionGeneration !== generation || !this.enabled()) return undefined;
    const { ticket } = await this.client.requestSessionAccessTicket(sessionId, challenge, holderId);
    if (this.stopped || this.sessionGeneration !== generation || !this.enabled()) {
      await this.client.releaseSessionAccess(holderId, sessionId, AbortSignal.timeout(500)).catch(() => {});
      return undefined;
    }
    return ticket;
  }
}
