import type { Klient } from '@kiki/klient';
import { createKlient } from '@kiki/klient/http';
import type {
  ApprovalResolveRequest,
  ApprovalResolveResult,
  GoalSnapshot,
  ListModelsResponse,
  ListNamedAgentProfilesResponse,
  MessageContent,
  PromptAbortResponse,
  PromptMoveRequest,
  PromptMoveResult,
  PromptReplaceRequest,
  PromptReplaceResult,
  PromptSteerResult,
  PromptSubmission,
  PromptSubmitResult,
  QuestionDismissResult,
  QuestionResolveRequest,
  QuestionResolveResult,
  Session,
  UpdateSessionProfileRequest,
} from '@kiki/protocol';

import {
  API_CODES,
  ApiError,
  type EditMessageRequest,
  type KikiForkSessionRequest,
  type RegenerateMessageRequest,
  type SessionTransport,
} from '@kiki/session-core/transport';

import { createSessionTransport } from '@kiki/session-core/session/klientTransport';
import type { DaemonConnection } from './discovery';

interface Envelope<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T;
  readonly request_id?: string;
}

export interface DaemonClientOptions extends DaemonConnection {
  readonly fetch?: typeof fetch;
  readonly WebSocket?: typeof WebSocket;
  readonly klient?: Klient;
}

export interface DaemonSessionSummary {
  readonly id: string;
  readonly title: string | undefined;
  readonly lastPrompt: string | undefined;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly custom: Readonly<Record<string, unknown>>;
}

export interface DaemonSessionPage {
  readonly items: readonly DaemonSessionSummary[];
  readonly nextCursor: string | undefined;
}

export class DaemonClient implements SessionTransport {
  readonly klient: Klient;
  readonly sessions = createSessionTransport({ session: (id) => this.klient.session(id) });
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DaemonClientOptions) {
    this.url = options.url.replace(/\/$/u, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.klient =
      options.klient ??
      createKlient({
        endpoint: this.url,
        token: this.token,
        WebSocket: options.WebSocket,
        fetch: options.fetch,
      });
  }

  async listSessions(limit = 50, before?: string): Promise<DaemonSessionPage> {
    const page = await this.klient.global.sessions.list({ limit, before, includeArchived: false });
    return {
      items: page.items.map((session) => ({
        id: session.id,
        title: session.title,
        lastPrompt: session.lastPrompt,
        cwd: session.cwd ?? '',
        updatedAt: session.updatedAt,
        custom: session.custom ?? {},
      })),
      nextCursor: page.nextCursor,
    };
  }

  async createSession(input: {
    readonly workDir: string;
    readonly additionalDirs?: readonly string[];
    readonly title?: string;
  }): Promise<{ readonly id: string }> {
    return this.klient.global.sessions.create(input);
  }

  listModels(): Promise<ListModelsResponse> {
    return this.request('GET', '/models');
  }

  listAgentProfiles(): Promise<ListNamedAgentProfilesResponse> {
    return this.request('GET', '/agents', undefined, { expand: 'true' });
  }

  listSkills(sessionId: string): Promise<{
    readonly skills: readonly {
      readonly name: string;
      readonly description: string;
      readonly source: 'project' | 'user' | 'extra' | 'builtin';
      readonly path: string;
      readonly type?: string;
      readonly prompt_command?: boolean;
      readonly argument_hint?: string;
    }[];
  }> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/skills`);
  }

  activateSkill(
    sessionId: string,
    name: string,
    args?: string,
    attachments?: readonly MessageContent[],
  ): Promise<{ readonly activated: true; readonly skill_name: string }> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(name)}:activate`,
      { args, attachments },
    );
  }

  updateSessionProfile(sessionId: string, body: UpdateSessionProfileRequest): Promise<Session> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/profile`, body);
  }

  setModel(sessionId: string, model: string): Promise<Session> {
    return this.updateSessionProfile(sessionId, { agent_config: { model } });
  }

  setPermission(sessionId: string, mode: 'manual' | 'yolo' | 'auto'): Promise<Session> {
    return this.updateSessionProfile(sessionId, { agent_config: { permission_mode: mode } });
  }

  setProfile(sessionId: string, profile: string): Promise<Session> {
    return this.updateSessionProfile(sessionId, { agent_config: { profile } });
  }

  setThinking(sessionId: string, thinking: string): Promise<Session> {
    return this.updateSessionProfile(sessionId, { agent_config: { thinking } });
  }

  setPlanMode(sessionId: string, planMode: boolean): Promise<Session> {
    return this.updateSessionProfile(sessionId, { agent_config: { plan_mode: planMode } });
  }

  setSwarmMode(sessionId: string, swarmMode: boolean): Promise<Session> {
    return this.updateSessionProfile(sessionId, { agent_config: { swarm_mode: swarmMode } });
  }

  setTitle(sessionId: string, title: string): Promise<Session> {
    return this.updateSessionProfile(sessionId, { title });
  }

  runShellCommand(sessionId: string, command: string) {
    return this.klient.session(sessionId).agent('main').runShellCommand({ command });
  }

  listAgents(sessionId: string) {
    return this.klient.session(sessionId).agents();
  }

  getSession(sessionId: string): Promise<Session> {
    return this.sessions.getSession(sessionId);
  }

  getGoal(sessionId: string): Promise<GoalSnapshot | null> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/goal`);
  }

  renewServerLease(leaseId?: string): Promise<{
    readonly lease_id: string;
    readonly expires_at: number;
  }> {
    return this.request('POST', '/leases', { lease_id: leaseId });
  }

  updateSessionSourceOverlay(
    sessionId: string,
    body: {
      readonly lease_id: string;
      readonly agent_files: readonly string[];
      readonly skill_dirs: readonly string[];
    },
  ): Promise<{ readonly profiles: number; readonly skills: number }> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/source-overlay`, body);
  }

  submitPrompt(sessionId: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    return this.sessions.submitPrompt(sessionId, body);
  }

  editMessage(sessionId: string, messageId: string, body: EditMessageRequest): Promise<PromptSubmitResult> {
    return this.sessions.editMessage(sessionId, messageId, body);
  }

  regenerateMessage(sessionId: string, messageId: string, body: RegenerateMessageRequest): Promise<PromptSubmitResult> {
    return this.sessions.regenerateMessage(sessionId, messageId, body);
  }

  forkSession(sessionId: string, body: KikiForkSessionRequest): Promise<Session> {
    return this.sessions.forkSession(sessionId, body);
  }

  undoSession(sessionId: string): Promise<unknown> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}:undo`, { count: 1 });
  }

  abortPrompt(sessionId: string, promptId: string): Promise<PromptAbortResponse> {
    return this.sessions.abortPrompt(sessionId, promptId);
  }

  movePrompt(sessionId: string, promptId: string, body: PromptMoveRequest): Promise<PromptMoveResult> {
    return this.sessions.movePrompt(sessionId, promptId, body);
  }

  replacePrompt(sessionId: string, promptId: string, body: PromptReplaceRequest): Promise<PromptReplaceResult> {
    return this.sessions.replacePrompt(sessionId, promptId, body);
  }

  steerPrompt(sessionId: string, promptId: string): Promise<PromptSteerResult> {
    return this.sessions.steerPrompt(sessionId, promptId);
  }

  resolveApproval(sessionId: string, approvalId: string, body: ApprovalResolveRequest): Promise<ApprovalResolveResult> {
    return this.sessions.resolveApproval(sessionId, approvalId, body);
  }

  resolveQuestion(sessionId: string, questionId: string, body: QuestionResolveRequest): Promise<QuestionResolveResult> {
    return this.sessions.resolveQuestion(sessionId, questionId, body);
  }

  dismissQuestion(sessionId: string, questionId: string): Promise<QuestionDismissResult> {
    return this.sessions.dismissQuestion(sessionId, questionId);
  }

  cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: boolean }> {
    return this.sessions.cancelTask(sessionId, taskId);
  }

  close(): Promise<void> {
    return this.klient.close();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    okCodes: readonly number[] = [API_CODES.SUCCESS],
  ): Promise<T> {
    const url = new URL(`${this.url}/api${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const envelope = (await response.json()) as Envelope<T>;
    if (!okCodes.includes(envelope.code)) throw new ApiError(envelope);
    return envelope.data;
  }
}
