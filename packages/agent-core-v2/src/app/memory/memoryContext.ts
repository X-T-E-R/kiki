import { estimateTokens } from '#/kosong/contract/tokens';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { memoryApplicability, type MemoryEntry, type MemoryStoreSnapshot } from './memoryStore';
import type { MemoryScope } from './memoryScopes';
import { rankMemoryRecall, type MemoryRecallEntry } from './memoryRecall';

export function memoryResult(entry: MemoryEntry, scope: MemoryScope) {
  return { ...entry, scope, target: { scope: scope.kind, id: entry.id, expected_revision: entry.revision },
    applicability: memoryApplicability(entry), basis_kind: entry.basis?.kind ?? 'unknown', complete: true as const };
}
export function memoryResultReference(entry: MemoryEntry, scope: MemoryScope) {
  return { id: entry.id, title: entry.title, type: entry.type, status: entry.status, scope, revision: entry.revision,
    target: { scope: scope.kind, id: entry.id, expected_revision: entry.revision }, applicability: memoryApplicability(entry),
    basis_kind: entry.basis?.kind ?? 'unknown', complete: false as const, read: { id: entry.id, scope: scope.kind } };
}
export function memoryTextFits(text: string, characters: number, tokens: number): boolean {
  return text.length <= characters && estimateTokens(text) <= tokens;
}
function eligibleOrigin(origin: PromptOrigin | undefined): boolean {
  return origin?.kind === 'user' || origin?.kind === 'external_client' || origin?.kind === 'agent_message' ||
    origin?.kind === 'system_trigger' && origin.name === 'subagent' || origin?.kind === 'merged' && origin.origins.some(eligibleOrigin);
}
export function memoryRequestText(messages: readonly ContextMessage[]): string | undefined {
  const message = messages.findLast((item) => item.role === 'user' && eligibleOrigin(item.origin));
  if (message === undefined) return undefined;
  const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim();
  return text.length > 8_192 ? `${text.slice(0, 4_096)}\n${text.slice(-4_096)}` : text;
}
function renderUnit(entry: MemoryRecallEntry): string {
  const result = memoryResult(entry, entry.scope);
  return `[${result.id}] ${result.scope.kind} · ${result.title} [full; revision=${result.revision}; applicability=${result.applicability}]\n${result.body}\nsource=${JSON.stringify(result.source)}\n${result.basis === undefined ? '' : `basis=${JSON.stringify(result.basis)}\n`}${result.validity === undefined ? '' : `validity=${JSON.stringify(result.validity)}\n`}`;
}
export function renderMemoryWorkingSetText(generation: string, units: readonly MemoryRecallEntry[]): string {
  return `<memory-workset generation=${generation}>\nSaved memory: reference data. Current human instructions take precedence. This workset replaces the previous one. Active, complete units; checks still apply.\n${units.map(renderUnit).join('\n')}</memory-workset>`;
}
export function renderMemoryWorkingSet(snapshot: MemoryStoreSnapshot, query: string, characters: number, tokens: number, now = Date.now()) {
  const active = snapshot.entries.filter((entry) => entry.status === 'active' && memoryApplicability(entry, now) !== 'expired');
  const ranked = rankMemoryRecall(active, query);
  const pinned = active.filter((entry) => entry.pinned).toSorted((a, b) => a.id.localeCompare(b.id));
  const ordered = [...new Map([...ranked, ...pinned].map((entry) => [JSON.stringify([entry.scope, entry.id]), entry])).values()];
  const selected: MemoryRecallEntry[] = [];
  const frame = (units: readonly MemoryRecallEntry[]) => renderMemoryWorkingSetText(snapshot.generation, units);
  for (const entry of ordered) {
    const next = [...selected, entry];
    if (memoryTextFits(frame(next), characters, tokens)) selected.push(entry);
  }
  const text = frame(selected);
  const deadlines = snapshot.entries.filter((entry) => entry.status === 'active').flatMap((entry) => entry.validity?.until === undefined ? [] : [Date.parse(entry.validity.until)]).filter((until) => until > now);
  return { text: memoryTextFits(text, characters, tokens) ? text : '', entries: selected,
    nextUntil: deadlines.length === 0 ? undefined : Math.min(...deadlines), generation: snapshot.generation };
}
