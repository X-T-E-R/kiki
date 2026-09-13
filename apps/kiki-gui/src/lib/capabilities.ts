/**
 * Capabilities data shaping — pure, unit-tested. Shared by the settings
 * skills catalog card and MCP status card (the old /capabilities page's
 * pipeline, re-homed into settings in the batch-3 split).
 *
 * Groups the workspace skill catalog by source and filters both skills and
 * MCP servers client-side. The wire `source` field is looser than the
 * protocol enum (`'plugin'` arrives from plugin skill roots, `'workspace'`
 * from older fixtures), so grouping normalizes instead of trusting the type.
 */

import type { McpServer, SkillDescriptor, Workspace } from '@kiki/protocol';

export type SkillGroupId = 'plugin' | 'project' | 'user' | 'extra' | 'builtin' | 'other';

/** Display order: plugin first (most specific), builtin last (largest, noisiest). */
export const SKILL_GROUP_ORDER: readonly SkillGroupId[] = [
  'plugin',
  'project',
  'user',
  'extra',
  'builtin',
  'other',
];

export interface SkillGroup {
  readonly id: SkillGroupId;
  readonly skills: readonly SkillDescriptor[];
}

/** Map a raw wire source string onto a display group. */
export function skillGroupId(source: string): SkillGroupId {
  switch (source) {
    case 'plugin':
      return 'plugin';
    // 'workspace' is the legacy spelling of project-scoped skills.
    case 'project':
    case 'workspace':
      return 'project';
    case 'user':
      return 'user';
    case 'extra':
      return 'extra';
    case 'builtin':
      return 'builtin';
    default:
      return 'other';
  }
}

/** Lowercase + trim once; empty means "no filtering". */
export function normalizeCapQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

export function skillMatchesQuery(skill: SkillDescriptor, rawQuery: string): boolean {
  const query = normalizeCapQuery(rawQuery);
  if (query === '') return true;
  return (
    skill.name.toLowerCase().includes(query) ||
    skill.description.toLowerCase().includes(query) ||
    skill.path.toLowerCase().includes(query)
  );
}

export function mcpServerMatchesQuery(server: McpServer, rawQuery: string): boolean {
  const query = normalizeCapQuery(rawQuery);
  if (query === '') return true;
  return (
    server.name.toLowerCase().includes(query) ||
    server.transport.toLowerCase().includes(query) ||
    server.status.toLowerCase().includes(query)
  );
}

/**
 * Filter + group the catalog. Groups follow SKILL_GROUP_ORDER; empty groups
 * are dropped (the page renders its own empty-filter state when nothing
 * survives anywhere).
 */
export function groupSkills(
  skills: readonly SkillDescriptor[],
  rawQuery: string,
): SkillGroup[] {
  const query = normalizeCapQuery(rawQuery);
  const buckets = new Map<SkillGroupId, SkillDescriptor[]>();
  for (const skill of skills) {
    if (!skillMatchesQuery(skill, query)) continue;
    const id = skillGroupId(skill.source);
    const bucket = buckets.get(id);
    if (bucket === undefined) buckets.set(id, [skill]);
    else bucket.push(skill);
  }
  return SKILL_GROUP_ORDER.flatMap((id) => {
    const grouped = buckets.get(id);
    return grouped === undefined ? [] : [{ id, skills: grouped }];
  });
}

export function filterMcpServers(
  servers: readonly McpServer[],
  rawQuery: string,
): McpServer[] {
  const query = normalizeCapQuery(rawQuery);
  return servers.filter((server) => mcpServerMatchesQuery(server, query));
}

/**
 * Resolve which workspace the page shows: an explicit request (deep-link
 * `?workspace=`) wins when it still exists, otherwise the first registered
 * workspace — the same default the settings skills card uses.
 */
export function pickWorkspace(
  workspaces: readonly Workspace[],
  requestedId: string | undefined,
): Workspace | undefined {
  if (requestedId !== undefined) {
    const requested = workspaces.find((workspace) => workspace.id === requestedId);
    if (requested !== undefined) return requested;
  }
  return workspaces[0];
}
