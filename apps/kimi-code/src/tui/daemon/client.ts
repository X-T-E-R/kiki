import type { Klient } from '@moonshot-ai/klient';
import { createKlient } from '@moonshot-ai/klient/http';
import type {
  ApprovalResolveRequest,
  ApprovalResolveResult,
  ListModelsResponse,
  ListNamedAgentProfilesResponse,
  PageResponse,
  PromptAbortResponse,
  PromptReplaceRequest,
  PromptReplaceResult,
  PromptSteerResult,
  PromptSubmission,
  PromptSubmitResult,
  QuestionDismissResult,
  QuestionResolveRequest,
  QuestionResolveResult,
  Session,
  SessionSnapshotResponse,
  UpdateSessionProfileRequest,
} from '@moonshot-ai/protocol';

import {
  API_CODES,
  ApiError,
  type AgentTranscriptResponse,
  type EditMessageRequest,
  type KikiForkSessionRequest,
  type RegenerateMessageRequest,
  type SessionTransport,
} from '@kiki/session-core/transport';

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
  readonly title: string;
  readonly lastPrompt: string | undefined;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly custom: Readonly<Record<string, unknown>>;
}

export class DaemonClient implements SessionTransport {
  readonly klient: Klient;
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
      });
  }

  async listSessions(limit = 100): Promise<PageResponse<DaemonSessionSummary>> {
    const page = await this.request<PageResponse<Session>>('GET', '/sessions', undefined, {
      page_size: limit,
    });
    return {
      items: page.items.map((session) => ({
        id: session.id,
        title: session.title,
        lastPrompt: session.last_prompt,
        cwd: session.metadata.cwd,
        updatedAt: Date.parse(session.updated_at),
        custom: session.metadata,
      })),
      has_more: page.has_more,
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
      readonly type?: string;
    }[];
  }> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/skills`);
  }

  activateSkill(
    sessionId: string,
    name: string,
    args?: string,
  ): Promise<{ readonly activated: true; readonly skill_name: string }> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(name)}:activate`,
      { args },
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

  snapshot(sessionId: string, options?: { readonly transcript?: boolean }): Promise<SessionSnapshotResponse> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/snapshot`, undefined, {
      mode: options?.transcript === true ? 'transcript' : undefined,
    });
  }

  getSession(sessionId: string): Promise<Session> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  getAgentTranscript(
    sessionId: string,
    agentId: string,
    options?: { readonly beforeTurn?: string; readonly afterTurn?: string; readonly pageSize?: number },
  ): Promise<AgentTranscriptResponse> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/transcript`, undefined, {
      agent_id: agentId,
      before_turn: options?.beforeTurn,
      after_turn: options?.afterTurn,
      page_size: options?.pageSize ?? 100,
    });
  }

  getTranscriptOps(
    sessionId: string,
    agentId: string,
    since: { readonly seq: number; readonly epoch?: string },
    grade: 'turn' | 'block' | 'delta' = 'delta',
  ): Promise<{
    readonly session_id: string;
    readonly agent_id: string;
    readonly epoch: string;
    readonly batches: readonly { readonly seq: number; readonly ops: readonly unknown[] }[];
    readonly through_seq: number;
    readonly complete: boolean;
  }> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/transcript/ops`, undefined, {
      agent_id: agentId,
      since_seq: since.seq,
      epoch: since.epoch,
      grade,
    });
  }

  submitPrompt(sessionId: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/prompts`, body);
  }

  editMessage(
    sessionId: string,
    messageId: string,
    body: EditMessageRequest,
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}:edit`,
      body,
    );
  }

  regenerateMessage(
    sessionId: string,
    messageId: string,
    body: RegenerateMessageRequest,
  ): Promise<unknown> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}:regenerate`,
      body,
    );
  }

  forkSession(sessionId: string, body: KikiForkSessionRequest): Promise<Session> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}:fork`, body);
  }

  abortPrompt(sessionId: string, promptId: string): Promise<PromptAbortResponse> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      {},
      undefined,
      [API_CODES.SUCCESS, API_CODES.PROMPT_ALREADY_COMPLETED],
    );
  }

  replacePrompt(
    sessionId: string,
    promptId: string,
    body: PromptReplaceRequest,
  ): Promise<PromptReplaceResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:replace`,
      body,
    );
  }

  steerPrompt(sessionId: string, promptId: string): Promise<PromptSteerResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:steer`,
      {},
    );
  }

  resolveApproval(
    sessionId: string,
    approvalId: string,
    body: ApprovalResolveRequest & { readonly selected_option_id?: string },
  ): Promise<ApprovalResolveResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      body,
    );
  }

  resolveQuestion(
    sessionId: string,
    questionId: string,
    body: QuestionResolveRequest,
  ): Promise<QuestionResolveResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`,
      body,
    );
  }

  dismissQuestion(sessionId: string, questionId: string): Promise<QuestionDismissResult> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}:dismiss`,
      {},
      undefined,
      [API_CODES.SUCCESS, API_CODES.QUESTION_DISMISSED],
    );
  }

  cancelTask(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    return this.request(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}:cancel`,
      {},
      undefined,
      [API_CODES.SUCCESS, API_CODES.TASK_ALREADY_FINISHED],
    );
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
    const url = new URL(`${this.url}/api/v1${path}`);
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
