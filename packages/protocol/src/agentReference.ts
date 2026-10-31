import type { AgentReference } from '@kiki/transcript';

export { agentReferenceSchema, agentRunSourceSchema } from '@kiki/transcript';
export type { AgentReference, AgentRunSource } from '@kiki/transcript';

export interface AgentRefMatch {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly profile: string;
}

export function agentRefLink(profile: string): string {
  return `kiki://agents/${encodeURIComponent(profile)}`;
}

export function findAgentRefs(text: string): AgentRefMatch[] {
  const refs: AgentRefMatch[] = [];
  for (const match of text.matchAll(/(^|[\s([（「“"'])(kiki:\/\/agents\/([^\s)\]）」”"'<>]+))/g)) {
    const raw = match[2]!.replace(/[.,;!?，。；！？]+$/, '');
    let profile: string;
    try { profile = decodeURIComponent(raw.slice('kiki://agents/'.length)); }
    catch { continue; }
    if (profile.length === 0 || /[\s\u0000-\u001F/#?]/.test(profile)) continue;
    const start = match.index + match[1]!.length;
    refs.push({ start, end: start + raw.length, raw, profile });
  }
  return refs;
}

function attr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll(/[\r\n]+/g, ' ');
}

export function agentRefsContext(refs: readonly AgentReference[], delegationAvailable: boolean): string {
  if (refs.length === 0) return '';
  const tags = refs.map(ref => `<agent_ref ref_id="${attr(ref.refId)}" profile="${attr(ref.profile)}" executor="${attr(ref.executor)}" configuration="${ref.configuration}"/>`);
  const hint = delegationAvailable
    ? 'The user referenced the agent targets above. You decide whether and how to delegate using AgentRun with the referenced profile, source_ref set to its ref_id, and a self-contained task. Current tool policy, dispatch constraints and approvals still apply. Do not switch the main engine or silently substitute a different target. For parallel write tasks on the same project, use separate admitted worktrees or directories; ask before sharing a writable directory.'
    : 'The user referenced these agent targets. Kiki delegation is not available to the current engine. These references do not grant tools or connect a collaboration bridge.';
  return `<agent_refs>\n${tags.join('\n')}\n${hint}\n</agent_refs>`;
}
