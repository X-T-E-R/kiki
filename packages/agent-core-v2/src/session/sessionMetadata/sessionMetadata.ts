import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SessionUsageSummary } from '#/app/sessionIndex/sessionIndex';
import type { TokenUsage } from '#/kosong/contract/usage';

export interface AgentMeta {
  readonly homedir?: string;
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: string | null;
  readonly delegator?: DelegatorRef;
  readonly forkedFrom?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly swarmItem?: string;
  readonly displayName?: string;
  readonly userLabel?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly executor?: string;
  readonly executorProtocol?: string;
}

export type DelegatorRef =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'external'; readonly delegationId: string };

export const SESSION_META_VERSION = 2;

export type SessionTitleKind = 'replaceable' | 'generated' | 'custom';

export interface SessionMeta {
  readonly id: string;
  readonly version?: number;
  readonly title?: string;
  readonly titleKind?: SessionTitleKind;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly cwd?: string;
  readonly forkedFrom?: string;
  readonly agents?: Readonly<Record<string, AgentMeta>>;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly usage?: SessionUsageSummary;
}

export type SessionMetaPatch = Partial<Omit<SessionMeta, 'id' | 'createdAt'>>;

export interface SessionMetadataChangedEvent {
  readonly changed: readonly (keyof SessionMeta)[];
}

export interface ISessionMetadata {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeMetadata: Event<SessionMetadataChangedEvent>;
  read(): Promise<SessionMeta>;
  usage(): SessionUsageSummary | undefined;
  recordUsage(model: string, usage: TokenUsage): void;
  update(patch: SessionMetaPatch, opts?: { readonly touchUpdatedAt?: boolean }): Promise<void>;
  setTitle(title: string): Promise<void>;
  /**
   * Applies a generated title unless the user customized theirs; the title
   * kind is re-checked inside the serialized update, right before the write,
   * so a custom title set while a generation was in flight still wins.
   * `force` skips the kind check entirely (explicit user-requested
   * regeneration — last writer wins).
   */
  setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean>;
  setArchived(archived: boolean): Promise<void>;
  registerAgent(agentId: string, meta: AgentMeta): Promise<void>;
  unregisterAgent?(agentId: string): Promise<void>;
  /**
   * True when the on-disk document could not vouch for its agent registry: either this instance
   * created the document because the session had none, or the stored document predates the
   * registry field. The registry is then empty by construction rather than because its agents
   * are gone, so consumers that read an empty registry as "the agent no longer exists" must not
   * act on it. Implementations without this method are treated as undecidable.
   */
  createdByLoad?(): boolean;
}

export const ISessionMetadata: ServiceIdentifier<ISessionMetadata> =
  createDecorator<ISessionMetadata>('sessionMetadata');
