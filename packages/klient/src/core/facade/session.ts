/**
 * The session facade — one `klient.session(id)` handle aggregating the
 * session-scope services (metadata, activity, approvals, questions,
 * interactions) plus the app-scope lifecycle service for close/archive/
 * restore/delete/fork/createChild. `agents()` reads the metadata registry (agent
 * handles are not serializable, so no agent-lifecycle channel exists on the
 * wire).
 */

import type { SessionActivityState } from '@kiki/agent-core-v2/session/sessionActivity/sessionActivity';
import type { IAgentCollaborationMessagingService } from '@kiki/agent-core-v2/session/agentCollaboration/messageMailbox';
import type { ISessionBtwService } from '@kiki/agent-core-v2/features/btw/btw';
import type { ISessionInitService } from '@kiki/agent-core-v2/features/sessionInit/sessionInit';
import type { ISessionCronService } from '@kiki/agent-core-v2/session/cron/sessionCronService';
import type { ISessionTodoService } from '@kiki/agent-core-v2/session/todo/sessionTodo';
import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@kiki/agent-core-v2/session/approval/approval';
import type {
  Interaction,
  InteractionKind,
} from '@kiki/agent-core-v2/session/interaction/interaction';
import type {
  QuestionRequest,
  QuestionResult,
} from '@kiki/agent-core-v2/session/question/question';
import type {
  AgentMeta,
  SessionMeta,
  SessionMetaPatch,
} from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { SkillSummary } from '@kiki/agent-core-v2/app/skillCatalog/types';

import type { ScopeRef } from '../channel.js';
import type { McpServerConfig } from '../../contract/mcp.js';
import type { ScopedCaller } from './global.js';

export type { ScopedCaller } from './global.js';

/** What `sessionLifecycleService.create/fork/createChild` leaves on the wire. */
interface HandleWire {
  readonly id: string;
}

/**
 * Options for `SessionFacade.restore` — mirrors the engine's
 * `ResumeSessionOptions`. `mcpServers` injects ephemeral per-session MCP
 * servers when restore re-materializes a cold session (ignored when the
 * session is already live).
 */
export interface SessionRestoreOptions {
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface SessionApprovalsFacade {
  list(): Promise<readonly ApprovalRequest[]>;
  decide(id: string, response: ApprovalResponse): Promise<void>;
}

export interface SessionQuestionsFacade {
  list(): Promise<readonly QuestionRequest[]>;
  answer(id: string, result: QuestionResult): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface SessionInteractionsFacade {
  list(kind?: InteractionKind): Promise<readonly Interaction[]>;
  respond(id: string, response: unknown): Promise<void>;
  acquireConsumer(id: string): Promise<void>;
  releaseConsumer(id: string): Promise<void>;
}

export interface SessionSkillsFacade {
  /**
   * Every skill in the session-merged catalog as a plain summary (the
   * catalog's readiness is resolved engine-side). Subscribe to
   * `session.events` `'skills.changed'` for updates.
   */
  list(): Promise<readonly SkillSummary[]>;
}

export interface SessionTodosFacade {
  get(agentId?: Parameters<ISessionTodoService['getTodos']>[0]): Promise<
    ReturnType<ISessionTodoService['getTodos']>
  >;
}

export interface SessionInitFacade {
  generateAgentsMd(): ReturnType<ISessionInitService['generateAgentsMd']>;
  cancelInit(): Promise<void>;
}

export interface SessionBtwFacade {
  start(): ReturnType<ISessionBtwService['start']>;
}

export interface SessionCronFacade {
  list(): Promise<ReturnType<ISessionCronService['list']>>;
  nextFireAt(taskId: string): Promise<ReturnType<ISessionCronService['getNextFireForTask']>>;
}

/** Compatibility phase mapped from one authoritative session activity snapshot. */
export type SessionStatus = 'running' | 'idle' | 'awaiting_approval' | 'awaiting_question';

export interface SessionFacade {
  get(): Promise<SessionMeta>;
  setTitle(title: string): Promise<void>;
  /**
   * Generate and apply a title from the main agent's first prompts via the
   * managed `chat_title` tool. `undefined` when generation is unavailable
   * (no managed OAuth login, no prompt yet, or a custom title is set).
   * `force` regenerates anyway, overwriting a generated or custom title.
   * `source` picks the conversation excerpt: `user_prompts` (default),
   * `first_turn` (opening prompt + first reply; strict), or `digest`
   * (head+tail of a multi-turn conversation).
   */
  generateTitle(opts?: {
    force?: boolean;
    source?: 'user_prompts' | 'first_turn' | 'digest';
  }): Promise<string | undefined>;
  update(patch: SessionMetaPatch): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
  status(): Promise<SessionStatus>;
  close(): Promise<void>;
  archive(): Promise<void>;
  /** Re-materialize without changing archive status; false when the session no longer exists. */
  resume(opts?: SessionRestoreOptions): Promise<boolean>;
  /** Re-materialize and unarchive; false when the session no longer exists. */
  restore(opts?: SessionRestoreOptions): Promise<boolean>;
  countPendingBackgroundTasks(): Promise<number>;
  drainBackgroundTasks(timeoutMs: number): Promise<void>;
  nextCronFireAt(): Promise<number | null>;
  readonly todos: SessionTodosFacade;
  readonly init: SessionInitFacade;
  readonly btw: SessionBtwFacade;
  readonly cron: SessionCronFacade;
  /** Permanently delete the session and its persisted data; throws when missing. */
  delete(): Promise<void>;
  fork(input?: { newSessionId?: string; title?: string; metadata?: Record<string, unknown>; turnIndex?: number }): Promise<SessionMeta>;
  createChild(input?: { newSessionId?: string; title?: string; metadata?: Record<string, unknown> }): Promise<SessionMeta>;
  readonly approvals: SessionApprovalsFacade;
  readonly questions: SessionQuestionsFacade;
  readonly interactions: SessionInteractionsFacade;
  readonly skills: SessionSkillsFacade;
  /** Agent id → metadata for every agent registered in this session. */
  agents(): Promise<Readonly<Record<string, AgentMeta>>>;
  sendUserAgentMessage(input: Parameters<IAgentCollaborationMessagingService['sendUserMessage']>[0]):
    ReturnType<IAgentCollaborationMessagingService['sendUserMessage']>;
}

export function createSessionFacade(call: ScopedCaller, sessionId: string): SessionFacade {
  const scope: ScopeRef = { sessionId };
  const read = (): Promise<SessionMeta> =>
    call(scope, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  const spawn = async (
    method: 'fork' | 'createChild',
    input: NonNullable<Parameters<SessionFacade['fork']>[0]> = {},
  ): Promise<SessionMeta> => {
    const handle = (await call({}, 'sessionManager', method, [
      { ...input, sourceSessionId: sessionId },
    ])) as HandleWire;
    return call({ sessionId: handle.id }, 'sessionMetadata', 'read', []) as Promise<SessionMeta>;
  };

  return {
    get: read,
    setTitle: (title) => call(scope, 'sessionMetadata', 'setTitle', [title]) as Promise<void>,
    generateTitle: (opts) =>
      call(scope, 'sessionTitleService', 'generateTitle', [opts]) as Promise<
        string | undefined
      >,
    update: (patch) => call(scope, 'sessionMetadata', 'update', [patch]) as Promise<void>,
    setArchived: (archived) =>
      call(scope, 'sessionMetadata', 'setArchived', [archived]) as Promise<void>,
    status: async () => {
      const state = await call(scope, 'sessionActivityView', 'state', []) as SessionActivityState;
      if (state.pendingInteraction === 'approval') return 'awaiting_approval';
      if (state.pendingInteraction === 'question') return 'awaiting_question';
      return state.busy ? 'running' : 'idle';
    },
    close: () => call({}, 'sessionManager', 'close', [sessionId]) as Promise<void>,
    archive: () => call({}, 'sessionManager', 'archive', [sessionId]) as Promise<void>,
    resume: async (opts) => {
      const handle = await call({}, 'sessionManager', 'resume', opts === undefined ? [sessionId] : [sessionId, opts]) as HandleWire | undefined;
      return handle !== undefined && handle !== null;
    },
    restore: async (opts) => {
      const handle = (await call({}, 'sessionManager', 'restore', [sessionId, opts])) as HandleWire | null;
      return handle !== null && handle !== undefined;
    },
    countPendingBackgroundTasks: () => call(scope, 'agentLifecycleService', 'countPendingBackgroundTasks', []) as Promise<number>,
    drainBackgroundTasks: (timeoutMs) => call(scope, 'agentLifecycleService', 'drainBackgroundTasks', [timeoutMs], { timeoutMs: 0 }) as Promise<void>,
    nextCronFireAt: () => call(scope, 'sessionCronService', 'getNextFireTime', []) as Promise<number | null>,
    todos: {
      get: (agentId) =>
        call(
          scope,
          'sessionTodoService',
          'getTodos',
          agentId === undefined ? [] : [agentId],
        ) as Promise<ReturnType<ISessionTodoService['getTodos']>>,
    },
    init: {
      generateAgentsMd: () =>
        call(scope, 'sessionInitService', 'generateAgentsMd', []) as ReturnType<ISessionInitService['generateAgentsMd']>,
      cancelInit: () =>
        call(scope, 'sessionInitService', 'cancelInit', []) as Promise<void>,
    },
    btw: {
      start: () => call(scope, 'sessionBtwService', 'start', []) as ReturnType<ISessionBtwService['start']>,
    },
    cron: {
      list: () =>
        call(scope, 'sessionCronService', 'list', []) as Promise<ReturnType<ISessionCronService['list']>>,
      nextFireAt: (taskId) =>
        call(scope, 'sessionCronService', 'getNextFireForTask', [taskId]) as Promise<ReturnType<ISessionCronService['getNextFireForTask']>>,
    },
    delete: () => call({}, 'sessionManager', 'delete', [sessionId]) as Promise<void>,
    fork: (input) => spawn('fork', input),
    createChild: (input) => spawn('createChild', input),

    approvals: {
      list: () =>
        call(scope, 'sessionApprovalService', 'listPending', []) as Promise<
          readonly ApprovalRequest[]
        >,
      decide: (id, response) =>
        call(scope, 'sessionApprovalService', 'decide', [id, response]) as Promise<void>,
    },

    questions: {
      list: () =>
        call(scope, 'sessionQuestionService', 'listPending', []) as Promise<
          readonly QuestionRequest[]
        >,
      answer: (id, result) =>
        call(scope, 'sessionQuestionService', 'answer', [id, result]) as Promise<void>,
      dismiss: (id) => call(scope, 'sessionQuestionService', 'dismiss', [id]) as Promise<void>,
    },

    interactions: {
      list: (kind) =>
        call(scope, 'sessionInteractionService', 'listPending', [kind]) as Promise<
          readonly Interaction[]
        >,
      respond: (id, response) =>
        call(scope, 'sessionInteractionService', 'respond', [id, response]) as Promise<void>,
      acquireConsumer: (id) =>
        call(scope, 'sessionInteractionService', 'acquireConsumer', [id]) as Promise<void>,
      releaseConsumer: (id) =>
        call(scope, 'sessionInteractionService', 'releaseConsumer', [id]) as Promise<void>,
    },

    skills: {
      list: () =>
        call(scope, 'sessionSkillCatalog', 'list', []) as Promise<readonly SkillSummary[]>,
    },

    agents: async () => {
      const meta = await read();
      return meta.agents ?? {};
    },
    sendUserAgentMessage: (input) =>
      call(scope, 'agentCollaborationMessagingService', 'sendUserMessage', [input], { timeoutMs: 0 }) as
        ReturnType<IAgentCollaborationMessagingService['sendUserMessage']>,
  };
}
