import { estimateTokens } from '#/kosong/contract/tokens';
import { sliceUtf16 } from '#/_base/text/utf16';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { memoryApplicability, type MemoryEntry, type MemoryStoreSnapshot } from './memoryStore';
import type { MemoryScope } from './memoryScopes';
import { rankMemoryRecall, type MemoryRecallEntry } from './memoryRecall';
import { memoryAdviceKey, type MemoryAdvice, type MemoryAdviceUse } from './memoryAdvisorTypes';
import { isMemoryVisibleOnHost } from './projectIdentityBindings';

export function memoryResult(entry: MemoryEntry, scope: MemoryScope) {
  return { ...entry, scope, target: { scope: scope.kind, id: entry.id, expected_revision: entry.revision },
    applicability: memoryApplicability(entry), host_applicability: entry.applicability ?? 'portable', basis_kind: entry.basis?.kind ?? 'unknown', complete: true as const };
}
export function memoryResultReference(entry: MemoryEntry, scope: MemoryScope) {
  return { id: entry.id, title: entry.title, type: entry.type, status: entry.status, scope, revision: entry.revision,
    target: { scope: scope.kind, id: entry.id, expected_revision: entry.revision }, applicability: memoryApplicability(entry),
    host_applicability: entry.applicability ?? 'portable',
    basis_kind: entry.basis?.kind ?? 'unknown', complete: false as const, read: { id: entry.id, scope: scope.kind } };
}
export function memoryTextFits(text: string, characters: number, tokens: number): boolean {
  return text.length <= characters && estimateTokens(text) <= tokens;
}
function countTokenCodepoints(text: string): { readonly ascii: number; readonly nonAscii: number } {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) ascii++;
    else nonAscii++;
  }
  return { ascii, nonAscii };
}
function eligibleOrigin(origin: PromptOrigin | undefined): boolean {
  return origin?.kind === 'user' || origin?.kind === 'external_client' || origin?.kind === 'agent_message' ||
    origin?.kind === 'system_trigger' && origin.name === 'subagent' || origin?.kind === 'merged' && origin.origins.some(eligibleOrigin);
}
export function memoryRequestIdentity(messages: readonly ContextMessage[]): string | undefined {
  const message = messages.findLast((item) => item.role === 'user' && eligibleOrigin(item.origin));
  return message?.id === undefined && message?.providerMessageId === undefined ? undefined : JSON.stringify([message.id, message.providerMessageId]);
}
function directingOrigin(origin: PromptOrigin | undefined, parentAgentId: string | undefined): boolean {
  return origin?.kind === 'user' || origin?.kind === 'external_client' || origin?.kind === 'system_trigger' && origin.name === 'subagent' ||
    parentAgentId !== undefined && origin?.kind === 'agent_message' && origin.senderAgentId === parentAgentId ||
    origin?.kind === 'merged' && origin.origins.some((item) => directingOrigin(item, parentAgentId));
}
/** Whether the latest request message directs this agent: human input or an assignment, or for a child an instruction from its parent. Reports from other agents do not. */
export function memoryRequestDirects(messages: readonly ContextMessage[], parentAgentId?: string): boolean {
  return directingOrigin(messages.findLast((item) => item.role === 'user' && eligibleOrigin(item.origin))?.origin, parentAgentId);
}
export function memoryRequestText(messages: readonly ContextMessage[]): string | undefined {
  const message = messages.findLast((item) => item.role === 'user' && eligibleOrigin(item.origin));
  if (message === undefined) return undefined;
  const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim();
  return text.length > 8_192 ? `${sliceUtf16(text, 0, 4_096)}\n${sliceUtf16(text, -4_096)}` : text;
}
function renderUnit(entry: MemoryRecallEntry, use?: MemoryAdviceUse): string {
  const result = memoryResult(entry, entry.scope);
  return `[${result.id}] ${result.scope.kind} · ${result.title} [full; revision=${result.revision}; applicability=${result.applicability}${use === undefined ? '' : `; use=${use}`}]\n${result.body}\nsource=${JSON.stringify(result.source)}\n${result.basis === undefined ? '' : `basis=${JSON.stringify(result.basis)}\n`}${result.validity === undefined ? '' : `validity=${JSON.stringify(result.validity)}\n`}`;
}
export function renderMemoryWorkingSetText(generation: string, units: readonly MemoryRecallEntry[], uses?: ReadonlyMap<string, MemoryAdviceUse>): string {
  return `<memory-workset generation=${generation}>\nSaved memory: reference data. Current human instructions take precedence. This workset replaces the previous one. Active, complete units; checks still apply.${uses?.size ? ' Advisor recommendations may omit relevant memory; history is background, not current authority.' : ''}\n${units.map((entry) => renderUnit(entry, uses?.get(memoryAdviceKey(entry)))).join('\n')}</memory-workset>`;
}
export function renderMemoryWorkingSet(
  snapshot: MemoryStoreSnapshot,
  query: string,
  characters: number,
  tokens: number,
  now = Date.now(),
  advice?: MemoryAdvice,
  currentHostId?: string,
) {
  const hostVisible = (entry: MemoryEntry): boolean =>
    currentHostId === undefined || isMemoryVisibleOnHost(entry, currentHostId);
  const active = snapshot.entries.filter((entry) => entry.status === 'active' && memoryApplicability(entry, now) !== 'expired' && hostVisible(entry));
  const ranked = rankMemoryRecall(active, query);
  const pinned = active.filter((entry) => entry.pinned).toSorted((a, b) => a.id.localeCompare(b.id));
  const current = new Map(active.map((entry) => [memoryAdviceKey(entry), entry]));
  const valid = (advice?.items ?? []).filter((item) => current.get(item.key)?.revision === item.revision);
  const uses = new Map(valid.filter((item) => item.use !== 'skip').map((item) => [item.key, item.use]));
  const priority = { apply: 0, history: 1, recommended: 2, skip: 3 };
  const recommended = valid.filter((item) => item.use !== 'skip').toSorted((a, b) => priority[a.use] - priority[b.use] || (b.score ?? 0) - (a.score ?? 0)).map((item) => current.get(item.key)!);
  const skipped = new Set(advice?.mode === 'select' ? valid.filter((item) => item.use === 'skip').map((item) => item.key) : []);
  const ordered = [...new Map([...ranked.filter((entry) => entry.score_details.exactIdentifier), ...recommended, ...ranked.filter((entry) => !skipped.has(memoryAdviceKey(entry)) || entry.pinned), ...pinned].map((entry) => [memoryAdviceKey(entry), entry])).values()];
  const selected: MemoryRecallEntry[] = [];
  const selectedUnits: string[] = [];
  const header = `<memory-workset generation=${snapshot.generation}>\nSaved memory: reference data. Current human instructions take precedence. This workset replaces the previous one. Active, complete units; checks still apply.${uses.size ? ' Advisor recommendations may omit relevant memory; history is background, not current authority.' : ''}\n`;
  const footer = '</memory-workset>';
  const headerCounts = countTokenCodepoints(header);
  const footerCounts = countTokenCodepoints(footer);
  let totalAscii = headerCounts.ascii + footerCounts.ascii;
  let totalNonAscii = headerCounts.nonAscii + footerCounts.nonAscii;
  let selectedChars = header.length + footer.length;
  for (const entry of ordered) {
    const currentTokens = Math.ceil(totalAscii / 4) + totalNonAscii;
    const remainingChars = characters - selectedChars;
    const remainingTokens = tokens - currentTokens;
    if (remainingChars < 48 || remainingTokens < 8) break;
    if (entry.id.length + entry.title.length + entry.body.length + 40 > remainingChars) continue;
    const unit = renderUnit(entry, uses.get(memoryAdviceKey(entry)));
    const sepChars = selectedUnits.length > 0 ? 1 : 0;
    const nextChars = selectedChars + sepChars + unit.length;
    if (nextChars > characters) continue;
    const unitCounts = countTokenCodepoints(unit);
    const nextAscii = totalAscii + sepChars + unitCounts.ascii;
    const nextNonAscii = totalNonAscii + unitCounts.nonAscii;
    const nextTokens = Math.ceil(nextAscii / 4) + nextNonAscii;
    if (nextTokens <= tokens) {
      selected.push(entry);
      selectedUnits.push(unit);
      selectedChars = nextChars;
      totalAscii = nextAscii;
      totalNonAscii = nextNonAscii;
    }
  }
  const text = `${header}${selectedUnits.join('\n')}${footer}`;
  const finalTokens = Math.ceil(totalAscii / 4) + totalNonAscii;
  const deadlines = snapshot.entries.filter((entry) => entry.status === 'active' && hostVisible(entry)).flatMap((entry) => entry.validity?.until === undefined ? [] : [Date.parse(entry.validity.until)]).filter((until) => until > now);
  return { text: selectedChars <= characters && finalTokens <= tokens ? text : '', entries: selected, uses,
    nextUntil: deadlines.length === 0 ? undefined : Math.min(...deadlines), generation: snapshot.generation };
}
