import type { ContextMessage } from '#/agent/contextMemory/types';
import { memoryApplicability, type MemoryStoreSnapshot } from './memoryStore';
import type { MemoryScope } from './memoryScopes';

export interface MemoryProjectionView extends MemoryStoreSnapshot {
  readonly scopes: readonly MemoryScope[];
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
function projectToolResult(message: ContextMessage, name: string | undefined, view: MemoryProjectionView): ContextMessage {
  if (message.role !== 'tool' || !['MemoryRead', 'MemorySearch', 'MemoryWrite'].includes(name ?? '') || message.content.length !== 1 || message.content[0]?.type !== 'text') return message;
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
function referenceArguments(args: string | null): string {
  let input: unknown;
  try { input = JSON.parse(args ?? 'null'); } catch { input = undefined; }
  return JSON.stringify({ action: record(input) ? input['action'] : undefined, id: record(input) ? input['id'] : undefined,
    scope: record(input) ? input['scope'] : undefined, memory_content_omitted: true });
}
export function memoryHandoffMessages(messages: readonly ContextMessage[]): readonly ContextMessage[] {
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const omitted = new Set<string>();
  const projected = messages.map((message) => {
    const current = withoutMemoryProjection(message);
    if (message.role !== 'tool' || !['MemoryRead', 'MemorySearch', 'MemoryWrite'].includes(calls.get(message.toolCallId ?? '') ?? '') || message.isError === true) return current;
    let output: unknown;
    try { output = JSON.parse(message.content[0]?.type === 'text' ? message.content[0].text : 'null'); } catch { return current; }
    const units = Array.isArray(output) ? output : record(output) ? Array.isArray(output['items']) ? output['items'] : [output['entry']] : [];
    if (!units.some((unit) => record(unit) && typeof unit['id'] === 'string' && typeof unit['revision'] === 'string')) return current;
    omitted.add(message.toolCallId!);
    return { ...current, content: [{ type: 'text' as const, text: 'Memory reference: resolve the current governed entry before reuse.' }] };
  });
  return projected.map((message) => message.toolCalls.some((call) => omitted.has(call.id) && call.name === 'MemoryWrite') ? { ...message,
    toolCalls: message.toolCalls.map((call) => omitted.has(call.id) && call.name === 'MemoryWrite' ? { ...call, arguments: referenceArguments(call.arguments) } : call) } : message);
}
export function projectCurrentMemory(messages: readonly ContextMessage[], view?: MemoryProjectionView): readonly ContextMessage[] {
  const latest = messages.findLastIndex((message) => range(message) !== undefined);
  const calls = new Map(messages.flatMap((message) => message.toolCalls.map((call) => [call.id, call.name] as const)));
  const staleWrites = new Set<string>();
  const projected = messages.map((message, index) => {
    const current = index < latest ? withoutMemoryProjection(message) : message;
    const result = view === undefined ? current : projectToolResult(current, calls.get(message.toolCallId ?? ''), view);
    if (result !== current && calls.get(message.toolCallId ?? '') === 'MemoryWrite') staleWrites.add(message.toolCallId!);
    return result;
  });
  if (staleWrites.size === 0) return projected;
  return projected.map((message) => message.toolCalls.some((call) => staleWrites.has(call.id)) ? { ...message,
    toolCalls: message.toolCalls.map((call) => staleWrites.has(call.id) ? { ...call, arguments: referenceArguments(call.arguments) } : call) } : message);
}
