import type { ContextMessage } from '#/agent/contextMemory/types';
import { memoryApplicability, type MemoryStoreSnapshot } from './memoryStore';
import type { MemoryScope } from './memoryScopes';
import type { MemoryRecallEntry } from './memoryRecall';
import { memoryAdviceKey, type MemoryAdviceUse } from './memoryAdvisorTypes';
import { renderMemoryWorkingSetText } from './memoryContext';

export interface MemoryProjectionView extends MemoryStoreSnapshot {
  readonly scopes: readonly MemoryScope[];
  readonly workset?: { readonly text: string; readonly entries: readonly MemoryRecallEntry[]; readonly uses?: ReadonlyMap<string, MemoryAdviceUse> };
}
export interface MemoryObservedReference {
  readonly scope: MemoryScope;
  readonly id: string;
  readonly observed_revision: string;
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
function referenceKey(reference: Pick<MemoryObservedReference, 'scope' | 'id'>): string {
  const scope = reference.scope;
  return JSON.stringify([scope.kind, 'workspaceId' in scope ? scope.workspaceId : null, 'personaId' in scope ? scope.personaId : null, reference.id]);
}
function availableEntry(reference: MemoryObservedReference, view: MemoryProjectionView) {
  return view.scopes.some((scope) => sameScope(scope, reference.scope))
    ? view.entries.find((entry) => entry.id === reference.id && sameScope(entry.scope, reference.scope)) : undefined;
}
function snapshotReferences(message: ContextMessage): readonly MemoryObservedReference[] | undefined {
  if (range(message) === undefined) return undefined;
  return (message.origin as { disclosure?: { memoryReferences?: readonly MemoryObservedReference[] } }).disclosure?.memoryReferences;
}
function projectToolResult(message: ContextMessage, name: string | undefined, view: MemoryProjectionView, delivered: Set<string>): ContextMessage {
  if (message.role !== 'tool' || message.isError === true || !['MemoryRead', 'MemorySearch', 'MemoryWrite'].includes(name ?? '') || message.content.length !== 1 || message.content[0]?.type !== 'text') return message;
  let output: unknown;
  try { output = JSON.parse(message.content[0].text); } catch { return message; }
  let changed = false;
  const unit = (value: unknown): unknown => {
    const reference = unitReference(value);
    if (reference === undefined || !record(value)) return value;
    if (availableEntry(reference, view) === undefined) {
      changed = true;
      return { id: reference.id, complete: false, reason: 'memory_unavailable', recovery: 'This content is no longer available in the current Memory view.' };
    }
    if (value['complete'] !== false && typeof value['body'] === 'string') {
      const key = JSON.stringify([referenceKey(reference), reference.observed_revision]);
      if (delivered.has(key)) {
        changed = true;
        return { id: reference.id, scope: reference.scope, revision: reference.observed_revision, complete: false, reason: 'memory_content_reused', read: { id: reference.id, scope: reference.scope.kind },
          recovery: 'The complete unit is already in an earlier Memory snapshot or tool result. Check the latest Memory authority update before reuse.' };
      }
      delivered.add(key);
    }
    return value;
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
function memoryToolUnits(message: ContextMessage, name: string | undefined): unknown[] {
  if (message.role !== 'tool' || !['MemoryRead', 'MemorySearch', 'MemoryWrite'].includes(name ?? '') || message.isError === true) return [];
  let output: unknown;
  try { output = JSON.parse(message.content[0]?.type === 'text' ? message.content[0].text : 'null'); } catch { return []; }
  return Array.isArray(output) ? output : record(output) ? Array.isArray(output['items']) ? output['items'] : record(output['entry']) ? [{ ...output['entry'], scope: output['owner_scope'] }] : [] : [];
}
function unitReference(unit: unknown): MemoryObservedReference | undefined {
  if (!record(unit) || typeof unit['id'] !== 'string' || typeof unit['revision'] !== 'string' || !record(unit['scope'])) return undefined;
  const value = unit['scope'];
  let scope: MemoryScope;
  if (value['kind'] === 'global') scope = { kind: 'global' };
  else if (value['kind'] === 'workspace' && typeof value['workspaceId'] === 'string') scope = { kind: 'workspace', workspaceId: value['workspaceId'] };
  else if (value['kind'] === 'persona' && typeof value['personaId'] === 'string') scope = { kind: 'persona', personaId: value['personaId'] };
  else if (value['kind'] === 'persona_workspace' && typeof value['workspaceId'] === 'string' && typeof value['personaId'] === 'string') scope = { kind: 'persona_workspace', workspaceId: value['workspaceId'], personaId: value['personaId'] };
  else return undefined;
  return { scope, id: unit['id'], observed_revision: unit['revision'] };
}
function observedReferences(message: ContextMessage, name: string | undefined): MemoryObservedReference[] {
  return memoryToolUnits(message, name).flatMap((unit) => {
    const reference = unitReference(unit);
    return reference === undefined ? [] : [reference];
  });
}
function completeSnapshotReferences(message: ContextMessage): readonly MemoryObservedReference[] {
  if (range(message) === undefined) return [];
  const disclosure = (message.origin as { disclosure?: { memoryCompleteReferences?: readonly MemoryObservedReference[] } }).disclosure;
  return disclosure?.memoryCompleteReferences ?? snapshotReferences(message) ?? [];
}
export function memorySnapshotDelivery(messages: readonly ContextMessage[], view: MemoryProjectionView) {
  const workset = view.workset;
  if (workset === undefined || !workset.text) return undefined;
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const delivered = new Set(messages.flatMap((message) => [...(snapshotReferences(message)?.every((reference) => availableEntry(reference, view) !== undefined) ? completeSnapshotReferences(message) : []), ...memoryToolUnits(message, calls.get(message.toolCallId ?? '')).flatMap((unit) => {
    const reference = unitReference(unit);
    return reference === undefined || !record(unit) || unit['complete'] === false || typeof unit['body'] !== 'string' ? [] : [reference];
  })]).map((reference) => JSON.stringify([referenceKey(reference), reference.observed_revision])));
  const complete = workset.entries.filter((entry) => !delivered.has(JSON.stringify([referenceKey(entry), entry.revision])));
  const references = complete.map((entry) => ({ scope: entry.scope, id: entry.id, observed_revision: entry.revision }));
  if (complete.length === workset.entries.length) return { text: workset.text, references };
  const reused = workset.entries.filter((entry) => !complete.includes(entry)).map((entry) => JSON.stringify({ scope: entry.scope, id: entry.id, revision: entry.revision, use: workset.uses?.get(memoryAdviceKey(entry)) }));
  const generation = /^<memory-workset generation=([^>]*)>/.exec(workset.text)?.[1] ?? view.generation;
  const text = renderMemoryWorkingSetText(generation, complete, workset.uses).replace('</memory-workset>', `Reused complete units from earlier history, selected for this workset; the latest Memory authority update governs validity:\n${reused.map((reference) => `- ${reference}`).join('\n')}\n</memory-workset>`);
  return { text, references };
}
export function memoryAuthorityUpdate(messages: readonly ContextMessage[], view: MemoryProjectionView, previous?: Readonly<Record<string, string>>) {
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const references = new Map(messages.flatMap((message) => [...snapshotReferences(message) ?? [], ...observedReferences(message, calls.get(message.toolCallId ?? ''))]).map((reference) => [referenceKey(reference), reference]));
  const states = Object.fromEntries([...references].map(([key, reference]) => {
    const current = availableEntry(reference, view);
    return [key, JSON.stringify({ scope: reference.scope, id: reference.id, revision: current?.revision, status: current?.status ?? 'unavailable',
      applicability: current === undefined ? undefined : memoryApplicability(current), superseded_by: current?.superseded_by,
      read: current === undefined ? undefined : { id: current.id, scope: current.scope.kind } })];
  }));
  const changed = Object.entries(states).filter(([key, value]) => previous?.[key] !== value);
  if (changed.length === 0) return undefined;
  return { content: `Memory authority update. These current states replace earlier states for the listed scope/ID pairs, including states in old snapshots and tool results. Earlier bodies and write arguments are historical observations, not current guidance. Reuse a complete body only when its revision matches the current active revision; preserve all validity checks. Archived, superseded, pending, expired, and unavailable memory is not active guidance. A changed revision requires a current workset unit or scoped MemoryRead before reuse. The latest workset still controls selection and Advisor use; this update does not promote background to authority.\n${changed.map(([, value]) => `- ${value}`).join('\n')}`,
    disclosure: { states } };
}
export function renderMemoryHandoffReferences(messages: readonly ContextMessage[]): string {
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const references = new Map(messages.flatMap((message) => observedReferences(message, calls.get(message.toolCallId ?? ''))).map((reference) => [referenceKey(reference), reference]));
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
  if (view === undefined) return messages;
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const writes = new Map<string, boolean>();
  const delivered = new Set<string>();
  const projected = messages.map((message) => {
    const references = snapshotReferences(message);
    const safeSnapshot = references !== undefined && references.every((reference) => availableEntry(reference, view) !== undefined);
    const current = range(message) === undefined || safeSnapshot ? message
      : view.scopes.length === 0 ? withoutMemoryProjection(message) : withoutMemoryWorkset(message);
    if (safeSnapshot) for (const reference of completeSnapshotReferences(message)) delivered.add(JSON.stringify([referenceKey(reference), reference.observed_revision]));
    const name = calls.get(message.toolCallId ?? '');
    if (name === 'MemoryWrite') {
      const observed = observedReferences(message, name);
      if (observed.length > 0) writes.set(message.toolCallId!, observed.every((reference) => availableEntry(reference, view) !== undefined));
    }
    return projectToolResult(current, name, view, delivered);
  });
  return projected.map((message) => message.toolCalls.some((call) => writes.has(call.id)) ? { ...message,
    toolCalls: message.toolCalls.map((call) => writes.has(call.id) ? { ...call, arguments: writes.get(call.id) ? currentWriteArguments(call.arguments) : historicalWriteArguments(call.arguments) } : call) } : message);
}
