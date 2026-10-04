/**
 * Pure tool capability grouping, counts, search and state previews for the
 * agent rail. Group identities are raw machine tokens, independent of labels
 * and availability; group and member order follow the reported tool list.
 */

import type { AgentToolCapability, CapabilityState } from './types';

/** The origin that determines a tool group's machine identity. */
export type ToolGroupKind = 'builtin' | 'mcp' | 'plugin' | 'user' | 'source';

/** Full-group availability counts, unaffected by search results. */
export interface ToolGroupCounts {
  readonly on: number;
  readonly total: number;
  readonly enabled: number;
  readonly approvalRequired: number;
  readonly disabled: number;
  readonly disconnected: number;
  readonly unknown: number;
}

/** One category or provider with every reported member, in input order. */
export interface ToolGroup {
  readonly key: string;
  readonly kind: ToolGroupKind;
  readonly token: string;
  readonly ownerReported: boolean;
  readonly extension: boolean;
  readonly tools: readonly AgentToolCapability[];
  readonly counts: ToolGroupCounts;
}

/** Search matches retain the group's complete membership and counts. */
export interface ToolGroupMatch {
  readonly group: ToolGroup;
  readonly matched: readonly AgentToolCapability[];
  readonly groupHit: boolean;
}

/** Independently capped name lists for each reported availability bucket. */
export interface ToolGroupPreview {
  readonly onNames: readonly string[];
  readonly offNames: readonly string[];
  readonly disconnectedNames: readonly string[];
  readonly unknownCount: number;
}

/** Owner parsed from the wire name prefix; falls back to source without inventing an owner. */
export function extensionOwner(tool: AgentToolCapability): { kind: 'mcp' | 'plugin'; owner: string; ownerReported: boolean } | undefined {
  const match = /^(mcp|plugin)__(.+?)__/.exec(tool.name);
  if (match !== null) {
    return { kind: match[1] as 'mcp' | 'plugin', owner: match[2]!, ownerReported: true };
  }
  if (tool.source === 'mcp' || tool.source === 'plugin') {
    return { kind: tool.source, owner: 'unknown', ownerReported: false };
  }
  return undefined;
}

/** `mcp__github__search_issues` becomes `search_issues`; plain names stay unchanged. */
export function toolShortName(name: string): string {
  const match = /^(?:mcp|plugin)__.+?__(.+)$/.exec(name);
  return match?.[1] ?? name;
}

/** Group every reported tool by raw category or origin, in first-appearance order. */
export function toolGroups(tools: readonly AgentToolCapability[]): readonly ToolGroup[] {
  const groups = new Map<string, {
    key: string;
    kind: ToolGroupKind;
    token: string;
    ownerReported: boolean;
    extension: boolean;
    tools: AgentToolCapability[];
  }>();
  for (const tool of tools) {
    const owner = extensionOwner(tool);
    const kind: ToolGroupKind = owner?.kind ?? (
      tool.source === 'user' ? 'user'
        : tool.source === undefined || tool.source === '' || tool.source === 'builtin' ? 'builtin'
          : 'source'
    );
    const token = owner?.owner ?? (
      kind === 'user' ? 'custom' : kind === 'builtin' ? tool.category || 'other' : tool.source!
    );
    const key = `${kind}:${token}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        kind,
        token,
        ownerReported: owner?.ownerReported ?? true,
        extension: kind === 'mcp' || kind === 'plugin',
        tools: [],
      };
      groups.set(key, group);
    }
    group.tools.push(tool);
  }
  return [...groups.values()].map((group) => {
    const counts = { on: 0, total: group.tools.length, enabled: 0, approvalRequired: 0, disabled: 0, disconnected: 0, unknown: 0 };
    for (const tool of group.tools) {
      if (tool.state === 'approval-required') counts.approvalRequired += 1;
      else counts[tool.state] += 1;
    }
    counts.on = counts.enabled + counts.approvalRequired;
    return { ...group, counts };
  });
}

/** Match group titles/tokens or individual tool names/descriptions without narrowing counts. */
export function matchToolGroups(
  groups: readonly ToolGroup[],
  query: string,
  titleOf: (group: ToolGroup) => string,
): readonly ToolGroupMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return groups.map((group) => ({ group, matched: group.tools, groupHit: true }));
  const matches: ToolGroupMatch[] = [];
  for (const group of groups) {
    const groupHit = [titleOf(group), group.token].some((value) => value.toLowerCase().includes(needle));
    const matched = groupHit ? group.tools : group.tools.filter((tool) =>
      [tool.name, toolShortName(tool.name), tool.description]
        .some((value) => value !== undefined && value.toLowerCase().includes(needle)),
    );
    if (matched.length > 0 || groupHit) matches.push({ group, matched, groupHit });
  }
  return matches;
}

/** Preview each state bucket independently, shortening extension names only. */
export function toolGroupPreview(group: ToolGroup, limit = 5): ToolGroupPreview {
  const onNames: string[] = [];
  const offNames: string[] = [];
  const disconnectedNames: string[] = [];
  let unknownCount = 0;
  for (const tool of group.tools) {
    const name = group.extension ? toolShortName(tool.name) : tool.name;
    switch (toolStateBucket(tool.state)) {
      case 'on': onNames.push(name); break;
      case 'off': offNames.push(name); break;
      case 'disconnected': disconnectedNames.push(name); break;
      case 'unknown': unknownCount += 1; break;
    }
  }
  return {
    onNames: onNames.slice(0, limit),
    offNames: offNames.slice(0, limit),
    disconnectedNames: disconnectedNames.slice(0, limit),
    unknownCount,
  };
}

/** Approval-required is on; off, disconnected and unknown remain distinct buckets. */
export function toolStateBucket(state: CapabilityState): 'on' | 'off' | 'disconnected' | 'unknown' {
  switch (state) {
    case 'enabled':
    case 'approval-required':
      return 'on';
    case 'disabled':
      return 'off';
    case 'disconnected':
      return 'disconnected';
    case 'unknown':
      return 'unknown';
  }
}
