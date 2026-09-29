import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { MEMORY_SECTION, memoryEnabled, type MemoryConfig } from './configSection';
import { IMemoryStore, type MemoryEntry } from './memoryStore';
import type { MemoryScope } from './memoryScopes';

export interface IAgentMemorySnapshot {
  readonly _serviceBrand: undefined;
  get(): Promise<string>;
  getSessionEntries(): Promise<readonly string[]>;
  invalidate(): void;
}
export const IAgentMemorySnapshot = createDecorator<IAgentMemorySnapshot>('agentMemorySnapshot');

export class AgentMemorySnapshot implements IAgentMemorySnapshot {
  declare readonly _serviceBrand: undefined;
  private frozen?: Promise<string>;
  private frozenRelated: readonly string[] = [];
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

  invalidate(): void { this.frozen = undefined; this.frozenRelated = []; }

  private async render(settings: MemoryConfig): Promise<string> {
    const store = this.instantiation.invokeFunction((accessor) => accessor.get(IMemoryStore));
    const snapshot = await renderMemorySnapshot(settings, this.session.workspaceId, store, this.session.sessionId);
    this.frozenRelated = snapshot.related;
    return snapshot.text;
  }
}

export async function renderMemorySnapshot(
  settings: MemoryConfig | undefined,
  workspaceId: string,
  store: IMemoryStore,
  sessionId?: string,
): Promise<{ readonly text: string; readonly related: readonly string[] }> {
  const budget = settings?.budget ?? 0;
  if (!memoryEnabled(settings, workspaceId) || settings?.approval === 'off' || budget === 0) {
    return { text: '', related: [] };
  }
  const global: MemoryScope = { kind: 'global' };
  const workspace: MemoryScope = { kind: 'workspace', workspaceId };
  const [globalEntries, workspaceEntries] = await Promise.all([store.list(global), store.list(workspace)]);
  const related = sessionId === undefined ? [] : [...globalEntries, ...workspaceEntries]
    .filter((entry) => entry.status === 'active' && entry.source.session === sessionId)
    .map((entry) => `[${entry.id}] ${entry.title}: ${entry.body}`);
  const lines: string[] = [];
  const globalShare = Math.min(600, Math.floor(budget * 0.3));
  for (const [scope, entries, share] of [['global', globalEntries, globalShare], ['workspace', workspaceEntries, budget - globalShare]] as const) {
    let scopeUsed = 0;
    for (const entry of rank(entries)) {
      const line = `${scope} - [${entry.id}] ${entry.title}: ${entry.body.split(/[。.!?\n]/)[0] ?? ''}\n`;
      if (line.length > share - scopeUsed) continue;
      lines.push(line);
      scopeUsed += line.length;
    }
  }
  const activeCount = globalEntries.filter((entry) => entry.status === 'active').length + workspaceEntries.filter((entry) => entry.status === 'active').length;
  const header = '<memory>\n以下是用户记忆，仅作参考，以当前用户指令为准。\n';
  const footer = () => `另有 ${activeCount - lines.length} 条可用 MemorySearch 检索。\n</memory>`;
  while (lines.length && 3 + header.length + lines.join('').length + footer().length > budget) lines.pop();
  if (3 + header.length + footer().length > budget) return { text: '', related };
  return { text: `\n\n${header}${lines.join('')}${footer()}\n`, related };
}

function rank(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const weight: Record<MemoryEntry['type'], number> = { feedback: 4, user: 3, project: 2, reference: 1 };
  return entries.filter((entry) => entry.status === 'active').sort((a, b) => Number(b.pinned) - Number(a.pinned) || weight[b.type] - weight[a.type] || b.updated.localeCompare(a.updated));
}

registerScopedService(LifecycleScope.Agent, IAgentMemorySnapshot, AgentMemorySnapshot, ScopeActivation.OnDemand, 'memory');
