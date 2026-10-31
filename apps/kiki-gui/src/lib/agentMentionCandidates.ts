/**
 * Agent candidates for the `@` mention menu, matching the wire contract
 * `GET /api/agents/references` (protocol `rest/agentReferences`). The server is
 * the sole producer of the list: it hides targets blocked by hard policy and
 * returns fixable faults as `available: false`. This adapter only projects the
 * response for the menu — group, filter, and pick — and writes the
 * server-supplied `reference` link verbatim into the draft.
 *
 * Until 934's server handler ships, the caller feeds it a fixture response with
 * this exact shape; nothing here changes when the route goes live.
 */

import type { AgentReferenceCandidate, AgentReferenceCandidatesResponse } from '@kiki/protocol';

export interface AgentCandidateGroup {
  /** The wire `group` value: native engine, an external profile's engine, or main. */
  readonly group: AgentReferenceCandidate['group'];
  /** Display label for the group header (the candidate's engine_label). */
  readonly label: string;
  readonly candidates: readonly AgentReferenceCandidate[];
}

export interface AgentCandidateList {
  readonly groups: readonly AgentCandidateGroup[];
  /**
   * False when the current engine cannot delegate: references become plain
   * mentions and the menu says so (with `unavailableReason`) instead of
   * dropping the group.
   */
  readonly delegationAvailable: boolean;
  readonly unavailableReason?: string;
}

/** Group candidates by their wire `group` field, preserving server order. */
export function groupAgentCandidates(response: AgentReferenceCandidatesResponse): AgentCandidateList {
  const order: AgentReferenceCandidate['group'][] = ['native', 'profile', 'main'];
  const byGroup = new Map<AgentReferenceCandidate['group'], AgentReferenceCandidate[]>();
  for (const item of response.items) {
    const list = byGroup.get(item.group) ?? [];
    list.push(item);
    byGroup.set(item.group, list);
  }
  const groups = order.flatMap((group) => {
    const candidates = byGroup.get(group);
    if (candidates === undefined || candidates.length === 0) return [];
    return [{ group, label: candidates[0]!.engine_label, candidates }];
  });
  return {
    groups,
    delegationAvailable: response.delegation_available,
    unavailableReason: response.unavailable_reason,
  };
}

/**
 * Case-insensitive substring match on label, profile, and engine. Group headers
 * follow their surviving candidates; an empty query returns every group.
 */
export function filterAgentCandidates(
  groups: readonly AgentCandidateGroup[],
  query: string,
): AgentCandidateGroup[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...groups];
  return groups.flatMap((group) => {
    const candidates = group.candidates.filter((candidate) =>
      candidate.label.toLowerCase().includes(q) ||
      candidate.profile.toLowerCase().includes(q) ||
      candidate.engine_label.toLowerCase().includes(q),
    );
    return candidates.length > 0 ? [{ ...group, candidates }] : [];
  });
}
