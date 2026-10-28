import type { ContextMessage } from '#/agent/contextMemory/types';
import { memoryApplicability, type MemoryStoreSnapshot } from './memoryStore';
import type { MemoryScope } from './memoryScopes';
import type { MemoryRecallEntry } from './memoryRecall';
import { renderMemoryWorkingSetText } from './memoryContext';

export interface MemoryProjectionView extends MemoryStoreSnapshot {
  readonly scopes: readonly MemoryScope[];
  readonly workset?: { readonly text: string; readonly entries: readonly MemoryRecallEntry[] };
}
function range(message: ContextMessage): { start: number; length: number } | undefined {
  if (message.origin?.kind !== 'injection' || message.origin.variant !== 'runtime_snapshot') return undefined;
  const value = (message.origin.disclosure as { memoryRange?: { start?: number; length?: number } } | undefined)?.memoryRange;
  if (value === undefined || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.length) || value.start! < 0 || value.length! < 0) return undefined;
  return { start: value.start!, length: value.length! };
}
export function withoutMemoryProjection(message: ContextMessage): ContextMessage {
  const memory = range(message);
  if (memory === undefined || message.content.length !== 1 || message.content[0]?.type !== 'text') return message;
  const text = message.content[0].text;
  if (!text.slice(memory.start, memory.start + memory.length).startsWith('## Scoped memory — ')) return message;
  return { ...message, content: [{ type: 'text', text: text.slice(0, memory.start) + text.slice(memory.start + memory.length) }] };
}
export function withoutMemoryWorkset(message: ContextMessage): ContextMessage {
  const memory = range(message);
  if (memory === undefined || message.content[0]?.type !== 'text' || !message.content[0].text.slice(memory.start, memory.start + memory.length).includes('\n<memory-workset ')) return message;
  return withoutMemoryProjection(message);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sameScope(a: MemoryScope, b: Record<string, unknown>): boolean {
  return a.kind === b['kind'] && ('workspaceId' in a ? a.workspaceId : undefined) === b['workspaceId'] && ('personaId' in a ? a.personaId : undefined) === b['personaId'];
}
function entryKey(entry: Pick<MemoryRecallEntry, 'scope' | 'id' | 'revision'>): string {
  return JSON.stringify([entry.scope.kind, 'workspaceId' in entry.scope ? entry.scope.workspaceId : null, 'personaId' in entry.scope ? entry.scope.personaId : null, entry.id, entry.revision]);
}
function projectMemoryWorkset(message: ContextMessage, view: MemoryProjectionView, covered: ReadonlySet<string>): ContextMessage {
  const memory = range(message);
  const workset = view.workset;
  if (memory === undefined || workset === undefined || !workset.text || covered.size === 0 || message.content.length !== 1 || message.content[0]?.type !== 'text') return message;
  const prefix = '## Scoped memory — Saved memory / as-of projection\n';
  const text = message.content[0].text;
  if (text.slice(memory.start, memory.start + memory.length) !== prefix + workset.text) return message;
  const remaining = workset.entries.filter((entry) => !covered.has(entryKey(entry)));
  if (remaining.length === workset.entries.length) return message;
  const replacement = prefix + renderMemoryWorkingSetText(view.generation, remaining);
  return { ...message, content: [{ type: 'text', text: text.slice(0, memory.start) + replacement + text.slice(memory.start + memory.length) }] };
}
function projectToolResult(message: ContextMessage, name: string | undefined, view: MemoryProjectionView, delivered: Set<string>): ContextMessage {
  if (message.role !== 'tool' || message.isError === true || !['MemoryRead', 'MemorySearch', 'MemoryWrite'].includes(name ?? '') || message.content.length !== 1 || message.content[0]?.type !== 'text') return message;
  let output: unknown;
  try { output = JSON.parse(message.content[0].text); } catch { return message; }
  let changed = false;
  const unit = (value: unknown): unknown => {
    if (!record(value) || typeof value['id'] !== 'string') return value;
    const scope = value['scope'];
    const revision = value['revision'];
    if (!record(scope) || typeof revision !== 'string') return value;
    const visible = view.scopes.find((item) => sameScope(item, scope));
    const current = visible === undefined ? undefined : view.entries.find((entry) => entry.id === value['id'] && sameScope(entry.scope, scope));
    if (current?.revision === revision) {
      if (value['complete'] !== false && value['body'] === current.body) {
        const key = entryKey(current);
        if (delivered.has(key)) {
          changed = true;
          return { id: current.id, scope: current.scope, revision, complete: false, reason: 'memory_content_reused', read: { id: current.id, scope: current.scope.kind },
            recovery: 'The complete current unit is already in an earlier Memory tool result in this request.' };
        }
        delivered.add(key);
      }
      const applicability = memoryApplicability(current);
      if (value['applicability'] === undefined || value['applicability'] === applicability) return value;
      changed = true;
      return { ...value, applicability };
    }
    changed = true;
    return { id: value['id'], complete: false, reason: current === undefined ? 'memory_unavailable' : 'memory_revision_changed',
      read: current === undefined ? undefined : { id: current.id, scope: current.scope.kind },
      recovery: current === undefined ? 'This content is no longer available in the current Memory view.' : 'Use the current workset or read the current revision before relying on this entry.' };
  };
  if (Array.isArray(output)) output = output.map(unit);
  else if (record(output) && Array.isArray(output['items'])) output = { ...output, items: output['items'].map(unit) };
  else if (record(output) && record(output['entry'])) {
    const entry = unit({ ...output['entry'], scope: output['owner_scope'] });
    if (changed) output = { action: output['action'], outcome: output['outcome'], operation_id: output['operation_id'], entry };
  }
  return changed ? { ...message, content: [{ type: 'text', text: JSON.stringify(output) }] } : message;
}
function currentWriteArguments(args: string | null): string | null {
  let input: unknown;
  try { input = JSON.parse(args ?? 'null'); } catch { return args; }
  if (!record(input)) return args;
  const { body: _body, ...retained } = input;
  return JSON.stringify(retained);
}
function historicalWriteArguments(args: string | null): string {
  let input: unknown;
  try { input = JSON.parse(args ?? 'null'); } catch { input = undefined; }
  return JSON.stringify({ action: record(input) ? input['action'] : undefined, id: record(input) ? input['id'] : undefined,
    scope: record(input) ? input['scope'] : undefined, memory_content_omitted: true });
}
export interface MemoryObservedReference {
  readonly scope: MemoryScope;
  readonly id: string;
  readonly observed_revision: string;
}
function memoryToolUnits(message: ContextMessage, name: string | undefined): unknown[] {
  if (message.role !== 'tool' || !['MemoryRead', 'MemorySearch', 'MemoryWrite'].includes(name ?? '') || message.isError === true) return [];
  let output: unknown;
  try { output = JSON.parse(message.content[0]?.type === 'text' ? message.content[0].text : 'null'); } catch { return []; }
  return Array.isArray(output) ? output : record(output) ? Array.isArray(output['items']) ? output['items'] : record(output['entry']) ? [{ ...output['entry'], scope: output['owner_scope'] }] : [] : [];
}
function currentToolCoverage(messages: readonly ContextMessage[], calls: ReadonlyMap<string, string>, view: MemoryProjectionView): Set<string> {
  const covered = new Set<string>();
  for (const message of messages) for (const unit of memoryToolUnits(message, calls.get(message.toolCallId ?? ''))) {
    if (!record(unit) || unit['complete'] === false || typeof unit['body'] !== 'string' || !record(unit['scope'])) continue;
    const scope = unit['scope'];
    const current = view.entries.find((entry) => entry.id === unit['id'] && entry.revision === unit['revision'] && entry.body === unit['body'] && sameScope(entry.scope, scope));
    if (current !== undefined) covered.add(entryKey(current));
  }
  return covered;
}
function observedReferences(message: ContextMessage, name: string | undefined): MemoryObservedReference[] {
  return memoryToolUnits(message, name).flatMap((unit) => {
    if (!record(unit) || typeof unit['id'] !== 'string' || typeof unit['revision'] !== 'string' || !record(unit['scope'])) return [];
    const value = unit['scope'];
    let scope: MemoryScope;
    if (value['kind'] === 'global') scope = { kind: 'global' };
    else if (value['kind'] === 'workspace' && typeof value['workspaceId'] === 'string') scope = { kind: 'workspace', workspaceId: value['workspaceId'] };
    else if (value['kind'] === 'persona' && typeof value['personaId'] === 'string') scope = { kind: 'persona', personaId: value['personaId'] };
    else if (value['kind'] === 'persona_workspace' && typeof value['workspaceId'] === 'string' && typeof value['personaId'] === 'string') scope = { kind: 'persona_workspace', workspaceId: value['workspaceId'], personaId: value['personaId'] };
    else return [];
    return [{ scope, id: unit['id'], observed_revision: unit['revision'] }];
  });
}
export function renderMemoryHandoffReferences(messages: readonly ContextMessage[]): string {
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const references = new Map(messages.flatMap((message) => observedReferences(message, calls.get(message.toolCallId ?? ''))).map((reference) => [JSON.stringify([reference.scope, reference.id]), reference]));
  return references.size === 0 ? '' : `## Observed Memory references\nHistorical observations only; read by scope and ID to resolve current governed content before reuse.\n${[...references.values()].map((reference) => `- ${JSON.stringify(reference)}`).join('\n')}`;
}
export function memoryHandoffMessages(messages: readonly ContextMessage[]): readonly ContextMessage[] {
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const omitted = new Set<string>();
  const projected = messages.map((message) => {
    const current = withoutMemoryProjection(message);
    const references = observedReferences(message, calls.get(message.toolCallId ?? ''));
    if (references.length === 0) return current;
    omitted.add(message.toolCallId!);
    return { ...current, content: [{ type: 'text' as const, text: JSON.stringify({ memory_references: references, recovery: 'Historical observations only; read by scope and ID to resolve current governed content before reuse.' }) }] };
  });
  return projected.map((message) => message.toolCalls.some((call) => omitted.has(call.id) && call.name === 'MemoryWrite') ? { ...message,
    toolCalls: message.toolCalls.map((call) => omitted.has(call.id) && call.name === 'MemoryWrite' ? { ...call, arguments: historicalWriteArguments(call.arguments) } : call) } : message);
}
export function projectCurrentMemory(messages: readonly ContextMessage[], view?: MemoryProjectionView): readonly ContextMessage[] {
  const latest = messages.findLastIndex((message) => range(message) !== undefined);
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const writes = new Map<string, 'current' | 'historical'>();
  const delivered = new Set<string>();
  const projected = messages.map((message, index) => {
    const current = index < latest ? withoutMemoryProjection(message) : message;
    const name = calls.get(message.toolCallId ?? '');
    const result = view === undefined ? current : projectToolResult(current, name, view, delivered);
    const references = view === undefined || name !== 'MemoryWrite' ? [] : observedReferences(message, name);
    if (view !== undefined && references.length > 0) {
      const valid = references.every((reference) => view.scopes.some((scope) => sameScope(scope, reference.scope)) && view.entries.some((entry) =>
        entry.id === reference.id && entry.revision === reference.observed_revision && sameScope(entry.scope, reference.scope)));
      writes.set(message.toolCallId!, valid ? 'current' : 'historical');
    }
    return result;
  });
  const covered = view === undefined ? new Set<string>() : currentToolCoverage(projected, calls, view);
  return projected.map((message) => {
    const current = view === undefined ? message : projectMemoryWorkset(message, view, covered);
    return current.toolCalls.some((call) => writes.has(call.id)) ? { ...current,
      toolCalls: current.toolCalls.map((call) => writes.has(call.id) ? { ...call, arguments: writes.get(call.id) === 'current' ? currentWriteArguments(call.arguments) : historicalWriteArguments(call.arguments) } : call) } : current;
  });
}
