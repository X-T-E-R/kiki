import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { MEMORY_SECTION, memoryEnabled, type MemoryConfig } from './configSection';
import { IMemoryStore, type MemoryEntry } from './memoryStore';
import type { MemoryPublicScopeKind, MemoryScope } from './memoryScopes';

export interface MemoryPersonaContext {
  readonly id: string;
  readonly shared?: readonly MemoryPublicScopeKind[];
}

export interface IAgentMemorySnapshot {
  readonly _serviceBrand: undefined;
  get(): Promise<string>;
  getSessionEntries(): Promise<readonly string[]>;
  liveSessionEntries(): Promise<readonly MemoryEntry[]>;
  resolveReferences(text: string): Promise<readonly string[]>;
  getPersona(): MemoryPersonaContext | undefined;
  configurePersona(context?: MemoryPersonaContext): void;
  invalidate(): void;
}
export const IAgentMemorySnapshot = createDecorator<IAgentMemorySnapshot>('agentMemorySnapshot');

export class AgentMemorySnapshot implements IAgentMemorySnapshot {
  declare readonly _serviceBrand: undefined;
  private frozen?: Promise<string>;
  private frozenRelated: readonly string[] = [];
  private persona: MemoryPersonaContext | undefined;
  constructor(
    @IConfigService private readonly config: IConfigService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
  ) {}

  get(): Promise<string> {
    if (this.frozen !== undefined) return this.frozen;
    if (this.agent.agentId !== 'main') return this.frozen = Promise.resolve('');
    const settings = this.config.get<MemoryConfig>(MEMORY_SECTION);
    this.frozen = !memoryEnabled(settings, this.session.workspaceId) || settings.approval === 'off'
      ? Promise.resolve('') : this.render(settings).catch(() => '');
    return this.frozen;
  }

  async getSessionEntries(): Promise<readonly string[]> {
    await this.get();
    return this.frozenRelated;
  }

  async liveSessionEntries(): Promise<readonly MemoryEntry[]> {
    if (this.agent.agentId !== 'main') return [];
    const settings = this.config.get<MemoryConfig>(MEMORY_SECTION);
    if (!memoryEnabled(settings, this.session.workspaceId) || settings.approval === 'off') return [];
    try {
      const store = this.instantiation.invokeFunction((accessor) => accessor.get(IMemoryStore));
      const scopes = this.readScopes();
      const entries = (await Promise.all(scopes.map((scope) => store.list(scope)))).flat();
      return entries.filter((entry) => entry.status === 'active' && entry.source.session === this.session.sessionId)
        .sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 20);
    } catch { return []; }
  }

  async resolveReferences(text: string): Promise<readonly string[]> {
    if (this.agent.agentId !== 'main') return [];
    const settings = this.config.get<MemoryConfig>(MEMORY_SECTION);
    if (!memoryEnabled(settings, this.session.workspaceId) || settings.approval === 'off') return [];
    const ids = [...new Set([...text.matchAll(/\[(m_[a-zA-Z0-9_]+)\]/g)].map((match) => match[1]!))].slice(0, 20);
    if (ids.length === 0) return [];
    let store: IMemoryStore;
    try { store = this.instantiation.invokeFunction((accessor) => accessor.get(IMemoryStore)); }
    catch { return ids.map((id) => `- [${id}] (unavailable)`); }
    const scopes = this.readScopes();
    const lookup = async (id: string) => {
      for (const scope of scopes) {
        const entry = await store.get(scope, id);
        if (entry !== undefined) return { entry, scope };
      }
      return undefined;
    };
    return Promise.all(ids.map(async (id) => {
      try {
        let current = await lookup(id);
        const visited = new Set<string>();
        for (let hop = 0; hop < 20; hop++) {
          if (current === undefined) return `- [${id}] (unavailable)`;
          const { entry, scope } = current;
          if (visited.has(entry.id)) return `- [${id}] (unavailable: supersession cycle)`;
          visited.add(entry.id);
          const label = id === entry.id ? `[${id}]` : `[${id}] → [${entry.id}]`;
          if (entry.status === 'archived') return `- ${label} ${entry.title} (withdrawn)`;
          if (entry.status === 'pending') return `- ${label} (pending; not active)`;
          if (entry.status === 'active') return `- ${label} ${entry.title}`;
          if (entry.superseded_by === undefined || !/^m_[a-zA-Z0-9_]+$/.test(entry.superseded_by)) return `- ${label} (superseded; replacement unavailable)`;
          const next = await store.get(scope, entry.superseded_by);
          current = next === undefined ? undefined : { entry: next, scope };
        }
        return `- [${id}] (unavailable: supersession chain limit)`;
      } catch { return `- [${id}] (unavailable)`; }
    }));
  }

  getPersona(): MemoryPersonaContext | undefined {
    return this.persona;
  }

  configurePersona(context?: MemoryPersonaContext): void {
    const next = context === undefined ? undefined : {
      id: context.id,
      shared: normalizeShared(context.shared),
    };
    if (samePersona(this.persona, next)) return;
    this.persona = next;
    this.invalidate();
  }

  private readScopes(): MemoryScope[] {
    const shared = normalizeShared(this.persona?.shared);
    return [
      ...(shared.includes('workspace') ? [{ kind: 'workspace', workspaceId: this.session.workspaceId } as const] : []),
      ...(shared.includes('global') ? [{ kind: 'global' } as const] : []),
      ...(this.persona === undefined ? [] : [
        { kind: 'persona', personaId: this.persona.id } as const,
        { kind: 'persona_workspace', workspaceId: this.session.workspaceId, personaId: this.persona.id } as const,
      ]),
    ];
  }

  invalidate(): void { this.frozen = undefined; this.frozenRelated = []; }

  private async render(settings: MemoryConfig): Promise<string> {
    const store = this.instantiation.invokeFunction((accessor) => accessor.get(IMemoryStore));
    const snapshot = await renderMemorySnapshot(settings, this.session.workspaceId, store, this.session.sessionId, this.persona);
    this.frozenRelated = snapshot.related;
    return snapshot.text;
  }
}

export async function renderMemorySnapshot(
  settings: MemoryConfig | undefined,
  workspaceId: string,
  store: IMemoryStore,
  sessionId?: string,
  persona?: MemoryPersonaContext,
): Promise<{ readonly text: string; readonly related: readonly string[] }> {
  const budget = settings?.budget ?? 0;
  if (!memoryEnabled(settings, workspaceId) || settings?.approval === 'off' || budget === 0) {
    return { text: '', related: [] };
  }
  const shared = persona === undefined ? ['global', 'workspace'] as const : normalizeShared(persona.shared);
  const publicScopes: readonly MemoryScope[] = [
    ...(shared.includes('global') ? [{ kind: 'global' } as const] : []),
    ...(shared.includes('workspace') ? [{ kind: 'workspace', workspaceId } as const] : []),
  ];
  const ownScopes: readonly MemoryScope[] = persona === undefined ? [] : [
    { kind: 'persona', personaId: persona.id },
    { kind: 'persona_workspace', workspaceId, personaId: persona.id },
  ];
  const [publicEntries, ownEntries] = await Promise.all([
    Promise.all(publicScopes.map((scope) => store.list(scope))),
    Promise.all(ownScopes.map((scope) => store.list(scope))),
  ]);
  const entriesForKind = (kind: MemoryPublicScopeKind): readonly MemoryEntry[] => {
    const index = publicScopes.findIndex((scope) => scope.kind === kind);
    return index < 0 ? [] : publicEntries[index] ?? [];
  };
  const related = sessionId === undefined ? [] : [...publicEntries.flat(), ...ownEntries.flat()]
    .filter((entry) => entry.status === 'active' && entry.source.session === sessionId)
    .map((entry) => `[${entry.id}] ${entry.title}: ${entry.body}`);
  const lines: string[] = [];
  let ownStart = 0;
  const ownBudget = persona === undefined ? 0 : Math.floor(budget * 0.4);
  const publicBudget = budget - ownBudget;
  if (persona === undefined) {
    const globalShare = Math.min(600, Math.floor(budget * 0.3));
    appendEntries(lines, 'global', entriesForKind('global'), globalShare);
    appendEntries(lines, 'workspace', entriesForKind('workspace'), budget - globalShare);
  } else {
    const globalShare = shared.includes('global')
      ? shared.includes('workspace') ? Math.min(600, Math.floor(publicBudget * 0.3)) : publicBudget
      : 0;
    const workspaceShare = shared.includes('workspace') ? publicBudget - globalShare : 0;
    appendEntries(lines, 'global', entriesForKind('global'), globalShare);
    appendEntries(lines, 'workspace', entriesForKind('workspace'), workspaceShare);
    ownStart = lines.length;
    const [personaEntries, personaWorkspaceEntries] = ownEntries;
    const personaGlobalUsed = appendEntries(lines, `persona:${persona.id}`, personaEntries ?? [], ownBudget);
    appendEntries(lines, `persona_workspace:${persona.id}`, personaWorkspaceEntries ?? [], ownBudget - personaGlobalUsed);
  }
  const activeCount = [...publicEntries.flat(), ...ownEntries.flat()].filter((entry) => entry.status === 'active').length;
  const header = '<memory>\n以下是用户记忆，仅作参考，以当前用户指令为准。\n';
  const footer = () => `另有 ${Math.max(0, activeCount - lines.length)} 条可用 MemorySearch 检索。\n</memory>`;
  while (lines.length && 3 + header.length + lines.join('').length + footer().length > budget) {
    if (persona !== undefined && ownStart > 0) {
      lines.splice(ownStart - 1, 1);
      ownStart -= 1;
    } else {
      lines.pop();
    }
  }
  if (3 + header.length + footer().length > budget) return { text: '', related };
  return { text: `\n\n${header}${lines.join('')}${footer()}\n`, related };
}

function appendEntries(lines: string[], scope: string, entries: readonly MemoryEntry[], share: number): number {
  let scopeUsed = 0;
  for (const entry of rank(entries)) {
    const line = `${scope} - [${entry.id}] ${entry.title}: ${entry.body.split(/[。.!?\n]/)[0] ?? ''}\n`;
    if (line.length > share - scopeUsed) continue;
    lines.push(line);
    scopeUsed += line.length;
  }
  return scopeUsed;
}

function normalizeShared(shared: readonly MemoryPublicScopeKind[] | undefined): readonly MemoryPublicScopeKind[] {
  if (shared === undefined) return ['global', 'workspace'];
  const values = new Set(shared);
  return [
    ...(values.has('global') ? ['global' as const] : []),
    ...(values.has('workspace') ? ['workspace' as const] : []),
  ];
}

function samePersona(left: MemoryPersonaContext | undefined, right: MemoryPersonaContext | undefined): boolean {
  return left?.id === right?.id && JSON.stringify(left?.shared) === JSON.stringify(right?.shared);
}

function rank(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const weight: Record<MemoryEntry['type'], number> = { feedback: 4, user: 3, project: 2, reference: 1 };
  return entries.filter((entry) => entry.status === 'active').sort((a, b) => Number(b.pinned) - Number(a.pinned) || weight[b.type] - weight[a.type] || b.updated.localeCompare(a.updated));
}

registerScopedService(LifecycleScope.Agent, IAgentMemorySnapshot, AgentMemorySnapshot, ScopeActivation.OnDemand, 'memory');
