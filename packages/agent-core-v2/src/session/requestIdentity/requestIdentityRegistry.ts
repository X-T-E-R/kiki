import { createHash, randomUUID, randomBytes } from 'node:crypto';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

interface InstallationDocument {
  readonly id: string;
}

interface RequestIdentityRegistryDocument {
  readonly version: 1;
  readonly agents: Record<
    string,
    { nextTurnIndex: number; turnIndices: Record<string, number> }
  >;
}

interface TurnIdentity {
  readonly logicalId?: string;
  readonly turnIndex?: number;
  readonly parentTurnId?: string;
  readonly rootTurnId?: string;
  readonly threadId?: string;
  turnState?: string;
}

export interface RequestIdentitySnapshot {
  readonly installationId?: string;
  readonly sharedSessionId?: string;
  readonly threadId?: string;
  readonly agentSessionId?: string;
  readonly logicalId?: string;
  readonly turnIndex?: number;
  readonly parentTurnId?: string;
  readonly rootTurnId?: string;
  readonly parentThreadId?: string;
  readonly windowId?: string;
  readonly turnState?: string;
  setTurnState(value: string): void;
}

export interface IRequestIdentityInstallation {
  readonly _serviceBrand: undefined;
  get(): Promise<string>;
}

export const IRequestIdentityInstallation: ServiceIdentifier<IRequestIdentityInstallation> =
  createDecorator<IRequestIdentityInstallation>('requestIdentityInstallation');

export class RequestIdentityInstallation implements IRequestIdentityInstallation {
  declare readonly _serviceBrand: undefined;

  private current: Promise<string> | undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
  ) {}

  get(): Promise<string> {
    this.current ??= this.load();
    return this.current;
  }

  private async load(): Promise<string> {
    const scope = this.bootstrap.scope('store');
    const key = 'request-identity-installation.json';
    const stored = await this.docs.get<InstallationDocument>(scope, key);
    if (stored !== undefined && isUuid(stored.id)) return stored.id;
    const id = randomUUID();
    await this.docs.set(scope, key, { id });
    return id;
  }
}

export interface IRequestIdentityRegistry {
  readonly _serviceBrand: undefined;
  snapshot(input: {
    readonly agentId: string;
    readonly turnKey: string;
    readonly parentAgentId?: string;
    readonly parentTurnKey?: string;
    readonly rootAgentId?: string;
    readonly rootTurnKey?: string;
    readonly compactionWindow: number;
    readonly logicalIdKind: 'uuidv7' | 'uuidv4';
    readonly dimensions?: RequestIdentityDimensions;
  }): Promise<RequestIdentitySnapshot>;
}

export interface RequestIdentityDimensions {
  readonly installationIdentity: boolean;
  readonly sharedSessionIdentity: boolean;
  readonly agentSessionIdentity: boolean;
  readonly threadIdentity: boolean;
  readonly logicalRequestIdentity: boolean;
  readonly turnIndex: boolean;
  readonly turnState: boolean;
}

const ALL_IDENTITY_DIMENSIONS: RequestIdentityDimensions = {
  installationIdentity: true,
  sharedSessionIdentity: true,
  agentSessionIdentity: true,
  threadIdentity: true,
  logicalRequestIdentity: true,
  turnIndex: true,
  turnState: true,
};

export const IRequestIdentityRegistry: ServiceIdentifier<IRequestIdentityRegistry> =
  createDecorator<IRequestIdentityRegistry>('requestIdentityRegistry');

export class RequestIdentityRegistry implements IRequestIdentityRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly turnByAgent = new Map<string, Map<string, TurnIdentity>>();
  private readonly latestTurnByAgent = new Map<string, TurnIdentity>();
  private createdAt: Promise<number> | undefined;
  private registryDocument: Promise<RequestIdentityRegistryDocument> | undefined;
  private registryMutation: Promise<void> = Promise.resolve();

  constructor(
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IRequestIdentityInstallation private readonly installation: IRequestIdentityInstallation,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
  ) {}

  async snapshot(input: {
    readonly agentId: string;
    readonly turnKey: string;
    readonly parentAgentId?: string;
    readonly parentTurnKey?: string;
    readonly rootAgentId?: string;
    readonly rootTurnKey?: string;
    readonly compactionWindow: number;
    readonly logicalIdKind: 'uuidv7' | 'uuidv4';
    readonly dimensions?: RequestIdentityDimensions;
  }): Promise<RequestIdentitySnapshot> {
    const dimensions = input.dimensions ?? ALL_IDENTITY_DIMENSIONS;
    const installationId = dimensions.installationIdentity
      ? await this.installation.get()
      : undefined;
    const identitySeed = installationId ?? this.session.sessionId;
    const sessionCreatedAt =
      dimensions.logicalRequestIdentity && input.logicalIdKind === 'uuidv7'
        ? await (this.createdAt ??= this.metadata.read().then((meta) => meta.createdAt))
        : 0;
    const sharedSessionId = dimensions.sharedSessionIdentity
      ? stableUuid(identitySeed, this.session.sessionId, 'shared-session')
      : undefined;
    const threadId =
      dimensions.threadIdentity
        ? input.parentAgentId === undefined
          ? (sharedSessionId ?? stableUuid(identitySeed, this.session.sessionId, 'thread', input.agentId))
          : stableUuid(identitySeed, this.session.sessionId, 'thread', input.agentId)
        : undefined;
    const agentSessionId = dimensions.agentSessionIdentity
      ? stableUuid(
          identitySeed,
          this.session.sessionId,
          'agent-session',
          input.agentId,
        )
      : undefined;
    const needsTurn =
      dimensions.logicalRequestIdentity || dimensions.turnIndex || dimensions.turnState;
    let turn: TurnIdentity | undefined;
    if (needsTurn) {
      let turns = this.turnByAgent.get(input.agentId);
      if (turns === undefined) {
        turns = new Map();
        this.turnByAgent.set(input.agentId, turns);
      }
      turn = turns.get(input.turnKey);
      if (turn === undefined) {
        const acceptedTurnIndex = dimensions.turnIndex
          ? await this.acceptedTurnIndex(input.agentId, input.turnKey)
          : undefined;
        const parent =
          input.parentAgentId === undefined
            ? undefined
            : this.latestTurnByAgent.get(input.parentAgentId);
        turn = {
          logicalId: dimensions.logicalRequestIdentity
            ? logicalTurnId(
                input.logicalIdKind,
                input.turnKey,
                sessionCreatedAt,
                identitySeed,
                this.session.sessionId,
                input.agentId,
              )
            : undefined,
          turnIndex: acceptedTurnIndex,
          parentTurnId:
            dimensions.logicalRequestIdentity &&
            input.parentAgentId !== undefined &&
            input.parentTurnKey !== undefined
              ? logicalTurnId(
                  input.logicalIdKind,
                  input.parentTurnKey,
                  sessionCreatedAt,
                  identitySeed,
                  this.session.sessionId,
                  input.parentAgentId,
                )
              : parent?.logicalId,
          rootTurnId:
            dimensions.logicalRequestIdentity &&
            input.rootAgentId !== undefined &&
            input.rootTurnKey !== undefined
              ? logicalTurnId(
                  input.logicalIdKind,
                  input.rootTurnKey,
                  sessionCreatedAt,
                  identitySeed,
                  this.session.sessionId,
                  input.rootAgentId,
                )
              : (parent?.rootTurnId ?? parent?.logicalId),
          threadId,
        };
        turns.set(input.turnKey, turn);
        this.latestTurnByAgent.set(input.agentId, turn);
      }
    }
    return {
      installationId: dimensions.installationIdentity ? installationId : undefined,
      sharedSessionId,
      threadId,
      agentSessionId,
      logicalId: turn?.logicalId,
      turnIndex: turn?.turnIndex,
      parentTurnId: turn?.parentTurnId,
      rootTurnId: turn?.rootTurnId,
      parentThreadId:
        !dimensions.threadIdentity || input.parentAgentId === undefined
          ? undefined
          : (this.latestTurnByAgent.get(input.parentAgentId)?.threadId ??
            (input.parentAgentId === 'main'
              ? (sharedSessionId ??
                stableUuid(identitySeed, this.session.sessionId, 'thread', input.parentAgentId))
              : stableUuid(
                  identitySeed,
                  this.session.sessionId,
                  'thread',
                  input.parentAgentId,
                ))),
      windowId:
        threadId === undefined ? undefined : `${threadId}:${String(input.compactionWindow + 1)}`,
      turnState: turn?.turnState,
      setTurnState: (value) => {
        if (turn === undefined || !dimensions.turnState) return;
        if (turn.turnState !== undefined) return;
        turn.turnState = value;
      },
    };
  }

  private acceptedTurnIndex(agentId: string, turnKey: string): Promise<number> {
    const result = this.registryMutation.then(async () => {
      this.registryDocument ??= this.loadRegistryDocument();
      const document = await this.registryDocument;
      const agent = document.agents[agentId] ?? { nextTurnIndex: 1, turnIndices: {} };
      document.agents[agentId] = agent;
      const existing = agent.turnIndices[turnKey];
      if (existing !== undefined) return existing;
      const assigned = agent.nextTurnIndex;
      agent.turnIndices[turnKey] = assigned;
      agent.nextTurnIndex += 1;
      await this.docs.set(this.session.scope('request-identity'), 'registry.json', document);
      return assigned;
    });
    this.registryMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadRegistryDocument(): Promise<RequestIdentityRegistryDocument> {
    const stored = await this.docs.get<RequestIdentityRegistryDocument>(
      this.session.scope('request-identity'),
      'registry.json',
    );
    if (stored?.version === 1 && stored.agents !== undefined) return stored;
    return { version: 1, agents: {} };
  }
}

function stableUuid(...parts: readonly string[]): string {
  const bytes = createHash('sha256').update(parts.join('\u0000')).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5');
}

function uuidv7(): string {
  const bytes = randomBytes(16);
  let time = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5');
}

function logicalTurnId(
  kind: 'uuidv7' | 'uuidv4',
  turnKey: string,
  sessionCreatedAt: number,
  ...identity: readonly string[]
): string {
  if (!turnKey.startsWith('turn:')) return kind === 'uuidv7' ? uuidv7() : randomUUID();
  const bytes = createHash('sha256').update([...identity, turnKey].join('\u0000')).digest().subarray(0, 16);
  if (kind === 'uuidv4') {
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  } else {
    let time = BigInt(Math.max(0, sessionCreatedAt + turnIndex(turnKey, 0) - 1));
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(time & 0xffn);
      time >>= 8n;
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  }
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5');
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function turnIndex(turnKey: string, existingCount: number): number {
  const match = /^turn:(\d+)$/u.exec(turnKey);
  return match === null ? existingCount + 1 : Number(match[1]) + 1;
}

registerScopedService(
  LifecycleScope.App,
  IRequestIdentityInstallation,
  RequestIdentityInstallation,
  ScopeActivation.OnScopeCreated,
  'requestIdentity',
);

registerScopedService(
  LifecycleScope.Session,
  IRequestIdentityRegistry,
  RequestIdentityRegistry,
  ScopeActivation.OnScopeCreated,
  'requestIdentity',
);
