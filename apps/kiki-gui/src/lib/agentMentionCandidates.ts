/**
 * Agent candidates for the `@` mention menu, matching the wire contract
 * `GET /api/agents/references` (protocol `rest/agentReferences`). The server is
 * the sole producer of the list: it hides targets blocked by hard policy and
 * returns fixable faults as `available: false`. This adapter only projects the
 * response for the menu — group, filter, and label — and never rewrites the
 * server-supplied `reference` link, which is written verbatim into the draft.
 *
 * Until 934's server handler ships, the caller feeds it a fixture response with
 * this exact shape; nothing here changes when the route goes live.
 */

import type { AgentReferenceCandidate, AgentReferenceCandidatesResponse } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

export interface AgentCandidateGroup {
  /** The wire `group` value: native engine, an external profile's engine, or main. */
  readonly group: AgentReferenceCandidate['group'];
  /** Display label for the group header, resolved per group value (not per item). */
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

/** The group header is what the group IS, never the first item's engine. */
const GROUP_LABEL_KEY: Record<AgentReferenceCandidate['group'], I18nKey> = {
  native: 'composer.agentGroup.native',
  profile: 'composer.agentGroup.profile',
  main: 'composer.agentGroup.main',
};

const GROUP_ORDER: readonly AgentReferenceCandidate['group'][] = ['native', 'profile', 'main'];

/**
 * Reason codes the reference route reuses from the engine-availability
 * vocabulary. A known code localizes on the client; anything unknown falls
 * back to the server's own reason text (the server does not localize).
 */
const REASON_KEY: Readonly<Record<string, I18nKey>> = {
  executor_not_installed: 'composer.agentReason.executor_not_installed',
  executor_unavailable: 'composer.agentReason.executor_unavailable',
  engine_disabled: 'composer.agentReason.engine_disabled',
  logged_out: 'composer.agentReason.logged_out',
  defaults_unavailable: 'composer.agentReason.defaults_unavailable',
};

/** Localized unavailable reason for a candidate, with a server-text fallback. */
export function agentUnavailableReason(
  candidate: Pick<AgentReferenceCandidate, 'unavailable_reason' | 'unavailable_reason_code'>,
  t: (key: I18nKey, params?: Readonly<Record<string, string | number>>) => string,
): string {
  const key = candidate.unavailable_reason_code === undefined ? undefined : REASON_KEY[candidate.unavailable_reason_code];
  if (key !== undefined) return t(key);
  return candidate.unavailable_reason ?? t('composer.agentsUnavailable');
}

/** Group candidates by their wire `group` field, preserving server order. */
export function groupAgentCandidates(
  response: AgentReferenceCandidatesResponse,
  t: (key: I18nKey, params?: Readonly<Record<string, string | number>>) => string,
): AgentCandidateList {
  const byGroup = new Map<AgentReferenceCandidate['group'], AgentReferenceCandidate[]>();
  for (const item of response.items) {
    const list = byGroup.get(item.group) ?? [];
    list.push(item);
    byGroup.set(item.group, list);
  }
  const groups = GROUP_ORDER.flatMap((group) => {
    const candidates = byGroup.get(group);
    if (candidates === undefined || candidates.length === 0) return [];
    return [{ group, label: t(GROUP_LABEL_KEY[group]), candidates }];
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
