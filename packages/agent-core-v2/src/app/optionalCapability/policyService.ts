import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { type ConfigOrigin, IConfigService } from '#/app/config/config';
import { NATIVE_BROWSER_FLAG_ID } from '#/app/browser/flag';
import { COMPUTER_CONFIG_SECTION, type ComputerConfig } from '#/app/computer/configSection';
import { IFlagService } from '#/app/flag/flag';
import { MEMORY_SECTION, type MemoryConfig } from '#/app/memory/configSection';
import { THREAD_COMMUNICATION_SECTION, type ThreadCommunicationConfig } from '#/app/threadCommunication/configSection';
import { Error2, ErrorCodes } from '#/errors';
import { isComputerMcpConfig, setComputerConnectionSelection } from '#/mcpCore/computer';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import {
  admitOptionalCapability,
  LOCAL_CAPABILITY_HOST,
  OPTIONAL_CAPABILITY_DOCUMENT_SCOPE,
  OPTIONAL_CAPABILITY_IDS,
  optionalCapabilityDocumentKey,
  type CapabilityChoice,
  type OptionalCapabilityId,
} from './admit';
import { OPTIONAL_CAPABILITIES_SECTION, OPTIONAL_CAPABILITY_FACTORY_DEFAULTS, type OptionalCapabilitiesConfig } from './configSection';
import {
  IOptionalCapabilityPolicy,
  type AgentCapabilityContext,
  type CapabilityAdmitRequest,
  type CapabilityApplies,
  type CapabilityOrigin,
  type CapabilitySource,
  type OptionalCapabilityGlobalState,
  type OptionalCapabilityWireState,
  type SessionCapabilityRow,
  type SessionCapabilityView,
} from './policy';

interface StoredCapabilityDocument {
  readonly revision: number;
  readonly hostId: string;
  readonly overrides: Partial<Record<OptionalCapabilityId, 'on' | 'off'>>;
}

const USER_OFF = new Set<ConfigOrigin>(['home', 'memory', 'preset', 'base', 'env']);
const APPLIES: Record<OptionalCapabilityId, CapabilityApplies> = {
  browser: 'next-model-request',
  computer: 'next-model-request',
  memory: 'next-step',
  thread: 'next-step',
  web: 'next-model-request',
};

export class OptionalCapabilityPolicyService extends Service implements IOptionalCapabilityPolicy {
  declare readonly _serviceBrand: undefined;
  private readonly changes = this._register(new Emitter<{ readonly sessionId?: string }>());
  readonly onDidChange = this.changes.event;
  private readonly cache = new Map<string, StoredCapabilityDocument>();
  private readonly loaded = new Set<string>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly agents = new Map<string, AgentCapabilityContext>();
  private computerServers: readonly string[] = [];

  constructor(
    @IConfigService private readonly settings: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
  ) {
    super();
    this.publishComputerSelection();
    if (this.settings.onDidSectionChange !== undefined) {
      this._register(this.settings.onDidSectionChange(() => {
        this.publishComputerSelection();
        this.changes.fire({});
      }));
    }
  }

  private publishComputerSelection(): void {
    let connection: string | undefined;
    try {
      connection = this.settings.get<ComputerConfig>(COMPUTER_CONFIG_SECTION)?.connection;
    } catch {
      connection = undefined;
    }
    setComputerConnectionSelection(connection);
  }

  globalState(id: OptionalCapabilityId): OptionalCapabilityGlobalState {
    const legacy = this.legacy(id);
    if (legacy.unresolved) return legacy;
    const defaultsOrigin = this.originOf(OPTIONAL_CAPABILITIES_SECTION, `defaults.${id}`);
    if (defaultsOrigin === 'unreadable') {
      return { ...legacy, allowed: false, defaultOn: false, unresolved: true, origin: 'unreadable' };
    }
    const defaultsValue = this.boolAt(OPTIONAL_CAPABILITIES_SECTION, `defaults.${id}`);
    const defaultOn = defaultsOrigin !== 'default' && typeof defaultsValue === 'boolean' ? defaultsValue : legacy.defaultOn;
    return { ...legacy, defaultOn };
  }

  wireProjection(): Record<OptionalCapabilityId, OptionalCapabilityWireState> {
    const wire = {} as Record<OptionalCapabilityId, OptionalCapabilityWireState>;
    for (const id of OPTIONAL_CAPABILITY_IDS) {
      const state = this.globalState(id);
      wire[id] = {
        allowed: state.allowed,
        host_locked: state.hostLocked,
        default_on: state.defaultOn,
        origin: state.origin,
        unresolved: state.unresolved,
      };
    }
    return wire;
  }

  choice(sessionId: string, id: OptionalCapabilityId): CapabilityChoice {
    return this.cache.get(this.key(sessionId))?.overrides[id] ?? 'inherit';
  }

  load(sessionId: string): Promise<void> {
    const key = this.key(sessionId);
    if (this.loaded.has(key)) return Promise.resolve();
    const pending = this.loading.get(key);
    if (pending !== undefined) return pending;
    const task = this.readDocument(sessionId, key).finally(() => {
      if (this.loading.get(key) === task) this.loading.delete(key);
    });
    this.loading.set(key, task);
    return task;
  }

  async readSession(sessionId: string, workspaceId = ''): Promise<SessionCapabilityView> {
    await this.load(sessionId);
    return this.view(sessionId, workspaceId);
  }

  noteComputerServers(servers: readonly { readonly name: string; readonly transport?: string; readonly command?: string; readonly args?: readonly string[] }[]): void {
    const names = servers
      .filter((server) => server.transport !== undefined && server.command !== undefined && isComputerMcpConfig(server as McpServerConfig))
      .map((server) => server.name);
    if (names.length === this.computerServers.length && names.every((name, index) => name === this.computerServers[index])) return;
    this.computerServers = names;
    this.changes.fire({});
  }

  computerServerNames(): readonly string[] {
    return this.computerServers;
  }

  retain(sessionId: string, agentId: string, context: AgentCapabilityContext): void {
    this.agents.set(this.agentKey(sessionId, agentId), context);
  }

  release(sessionId: string, agentId: string): void {
    this.agents.delete(this.agentKey(sessionId, agentId));
  }

  admit(id: OptionalCapabilityId, request: CapabilityAdmitRequest): ReturnType<IOptionalCapabilityPolicy['admit']> {
    const key = this.key(request.sessionId);
    if (!this.loaded.has(key) && (this.loading.has(key) || this.failed.has(key))) {
      return { admitted: false, reason: 'origin_unreadable' };
    }
    const state = this.globalState(id);
    const agent = request.agentId === undefined ? undefined : this.agents.get(this.agentKey(request.sessionId, request.agentId));
    return admitOptionalCapability(id, {
      allowed: state.allowed,
      hostLocked: state.hostLocked,
      defaultOn: state.defaultOn,
      unresolved: state.unresolved,
      sessionChoice: this.choice(request.sessionId, id),
      workspaceHardOff: id === 'memory' && this.workspaceOff(request.workspaceId),
      agentKind: agent?.agentKind ?? 'main',
      toolsSource: agent?.toolsSource,
      declaredTools: agent?.declaredTools,
      taskTools: agent?.taskTools,
      computerServers: this.computerServers,
    });
  }

  setChoice(sessionId: string, id: OptionalCapabilityId, choice: CapabilityChoice, workspaceId = ''): Promise<SessionCapabilityView> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => this.applyChoice(sessionId, id, choice, workspaceId));
    this.queues.set(sessionId, write);
    return write;
  }

  anyMayUse(id: OptionalCapabilityId): boolean {
    const state = this.globalState(id);
    if (state.unresolved || !state.allowed) return false;
    if (state.defaultOn) return true;
    for (const document of this.cache.values()) {
      if (document.overrides[id] === 'on') return true;
    }
    for (const [key, context] of this.agents) {
      const split = key.indexOf('\u0000');
      const sessionId = key.slice(0, split);
      const agentId = key.slice(split + 1);
      if (this.admit(id, { sessionId, workspaceId: context.workspaceId, agentId }).admitted) return true;
    }
    return false;
  }

  private async readDocument(sessionId: string, key: string): Promise<void> {
    try {
      const stored = await this.store.get<StoredCapabilityDocument>(OPTIONAL_CAPABILITY_DOCUMENT_SCOPE, key);
      if (!this.cache.has(key)) this.cache.set(key, this.normalize(stored));
      this.failed.delete(key);
      this.loaded.add(key);
      this.changes.fire({ sessionId });
    } catch (error) {
      this.failed.add(key);
      this.changes.fire({ sessionId });
      throw error;
    }
  }

  private async applyChoice(sessionId: string, id: OptionalCapabilityId, choice: CapabilityChoice, workspaceId: string): Promise<SessionCapabilityView> {
    await this.load(sessionId);
    const state = this.globalState(id);
    if (choice === 'on') {
      if (state.unresolved) throw this.rejected('origin_unreadable');
      if (state.hostLocked && !state.allowed) throw this.rejected('host_locked');
      if (!state.allowed) throw this.rejected('allowed_off');
    }
    const key = this.key(sessionId);
    const current = this.cache.get(key) ?? this.normalize(undefined);
    const overrides = { ...current.overrides };
    if (choice === 'inherit') delete overrides[id];
    else overrides[id] = choice;
    const next: StoredCapabilityDocument = { revision: current.revision + 1, hostId: LOCAL_CAPABILITY_HOST, overrides };
    this.cache.set(key, next);
    try {
      await this.store.set(OPTIONAL_CAPABILITY_DOCUMENT_SCOPE, key, next);
    } catch (error) {
      if (this.cache.get(key)?.revision === next.revision) this.cache.set(key, current);
      throw error;
    }
    this.changes.fire({ sessionId });
    return this.view(sessionId, workspaceId);
  }

  private view(sessionId: string, workspaceId: string): SessionCapabilityView {
    const document = this.cache.get(this.key(sessionId)) ?? this.normalize(undefined);
    const rows = OPTIONAL_CAPABILITY_IDS.map((id) => this.row(sessionId, id, document, workspaceId));
    return { revision: document.revision, hostId: document.hostId, rows };
  }

  private row(sessionId: string, id: OptionalCapabilityId, document: StoredCapabilityDocument, workspaceId: string): SessionCapabilityRow {
    const state = this.globalState(id);
    const choice = document.overrides[id] ?? 'inherit';
    const main = this.agents.get(this.agentKey(sessionId, 'main'));
    const decision = this.admit(id, {
      sessionId,
      workspaceId: main?.workspaceId ?? workspaceId,
      agentId: main === undefined ? undefined : 'main',
    });
    const reason = main === undefined && decision.reason === 'default_off' ? 'unbound' : decision.reason;
    const source: CapabilitySource = !state.allowed || state.unresolved ? 'off' : choice === 'inherit' ? 'default' : 'session';
    return {
      id,
      choice,
      effective: decision.admitted,
      source,
      reason,
      allowed: state.allowed,
      hostLocked: state.hostLocked,
      defaultOn: state.defaultOn,
      unresolved: state.unresolved,
      applies: APPLIES[id],
    };
  }

  private legacy(id: OptionalCapabilityId): OptionalCapabilityGlobalState {
    if (id === 'browser') return this.browserState();
    if (id === 'web') return this.webState();
    if (id === 'thread') return this.threadState();
    if (id === 'computer') return this.booleanState(COMPUTER_CONFIG_SECTION, 'enabled', OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.computer);
    return this.booleanState(MEMORY_SECTION, 'enabled', OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.memory);
  }

  private browserState(): OptionalCapabilityGlobalState {
    const explained = this.flags.explain(NATIVE_BROWSER_FLAG_ID);
    if (explained === undefined) return this.unresolved();
    const origin: CapabilityOrigin = explained.source === 'env' ? 'env' : explained.source === 'config' ? 'home' : 'default';
    return {
      allowed: explained.enabled,
      hostLocked: explained.source === 'env',
      defaultOn: explained.source === 'default' ? OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.browser : explained.enabled,
      origin,
      unresolved: false,
    };
  }

  private webState(): OptionalCapabilityGlobalState {
    const origin = this.originOf(OPTIONAL_CAPABILITIES_SECTION, 'web.allowed');
    if (origin === 'unreadable') return this.unresolved();
    const value = this.boolAt(OPTIONAL_CAPABILITIES_SECTION, 'web.allowed');
    const allowed = origin === 'default' || value === undefined ? true : value;
    return { allowed, hostLocked: origin === 'env', defaultOn: OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.web, origin, unresolved: false };
  }

  private threadState(): OptionalCapabilityGlobalState {
    const origin = this.originOf(THREAD_COMMUNICATION_SECTION, 'enabled');
    if (origin === 'unreadable') return this.unresolved();
    if (origin === 'default') return { allowed: true, hostLocked: false, defaultOn: OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.thread, origin, unresolved: false };
    const enabled = this.boolAt(THREAD_COMMUNICATION_SECTION, 'enabled') === true;
    if (!enabled && !USER_OFF.has(origin)) return this.unresolved();
    return { allowed: enabled, hostLocked: origin === 'env', defaultOn: enabled, origin, unresolved: false };
  }

  private booleanState(domain: string, key: string, legacyWhenDefault: boolean): OptionalCapabilityGlobalState {
    const origin = this.originOf(domain, key);
    if (origin === 'unreadable') return this.unresolved();
    if (origin === 'default') return { allowed: true, hostLocked: false, defaultOn: legacyWhenDefault, origin, unresolved: false };
    const value = this.boolAt(domain, key);
    const allowed = value !== false;
    return { allowed, hostLocked: origin === 'env', defaultOn: allowed, origin, unresolved: false };
  }

  private unresolved(): OptionalCapabilityGlobalState {
    return { allowed: false, hostLocked: false, defaultOn: false, origin: 'unreadable', unresolved: true };
  }

  private workspaceOff(workspaceId: string): boolean {
    if (workspaceId === '') return false;
    try {
      return this.settings.get<MemoryConfig>(MEMORY_SECTION)?.workspaces?.[workspaceId] === false;
    } catch {
      return true;
    }
  }

  private originOf(domain: string, key: string): CapabilityOrigin {
    try {
      const map = this.settings.origins(domain);
      if (map === undefined || map === null || typeof map !== 'object') return 'unreadable';
      return map[key] ?? 'default';
    } catch {
      return 'unreadable';
    }
  }

  private boolAt(domain: string, key: string): boolean | undefined {
    try {
      let current: unknown = domain === OPTIONAL_CAPABILITIES_SECTION
        ? this.settings.get<OptionalCapabilitiesConfig>(domain)
        : domain === THREAD_COMMUNICATION_SECTION
          ? this.settings.get<ThreadCommunicationConfig>(domain)
          : domain === COMPUTER_CONFIG_SECTION
            ? this.settings.get<ComputerConfig>(domain)
            : this.settings.get<MemoryConfig>(domain);
      for (const part of key.split('.')) {
        if (current === undefined || current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return typeof current === 'boolean' ? current : undefined;
    } catch {
      return undefined;
    }
  }

  private normalize(stored: StoredCapabilityDocument | undefined): StoredCapabilityDocument {
    const overrides: Partial<Record<OptionalCapabilityId, 'on' | 'off'>> = {};
    for (const id of OPTIONAL_CAPABILITY_IDS) {
      const value = stored?.overrides?.[id];
      if (value === 'on' || value === 'off') overrides[id] = value;
    }
    return {
      revision: typeof stored?.revision === 'number' && stored.revision >= 0 ? stored.revision : 0,
      hostId: typeof stored?.hostId === 'string' && stored.hostId !== '' ? stored.hostId : LOCAL_CAPABILITY_HOST,
      overrides,
    };
  }

  private key(sessionId: string): string {
    return optionalCapabilityDocumentKey(LOCAL_CAPABILITY_HOST, sessionId);
  }

  private agentKey(sessionId: string, agentId: string): string {
    return `${sessionId}\u0000${agentId}`;
  }

  private rejected(reason: string): Error2 {
    return new Error2(ErrorCodes.REQUEST_INVALID, `Optional capability cannot be turned on (${reason}).`, { details: { reason } });
  }
}

registerScopedService(
  LifecycleScope.App,
  IOptionalCapabilityPolicy,
  OptionalCapabilityPolicyService,
  ScopeActivation.OnScopeCreated,
  'optionalCapability',
);
