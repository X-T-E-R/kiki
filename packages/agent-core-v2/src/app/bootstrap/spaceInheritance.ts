import type { SpaceHome } from './spaceHome';

export interface SpaceInheritanceInput {
  readonly baseHomeDir?: string;
  readonly space?: SpaceHome;
}

/** Resolved per-space resource inheritance: which base-home layers a home reads as a lower
 *  priority layer, and whether the OS-home generic roots (`~/.agents`) stay visible. */
export interface SpaceInheritance {
  readonly baseHomeDir?: string;
  readonly agents: boolean;
  readonly instructions: boolean | 'stack';
  readonly skills: boolean;
  readonly mcp: boolean;
  readonly appearance: boolean;
  readonly plugins: boolean;
  readonly genericRoots: boolean;
}

export function resolveSpaceMcpBaseSelection(input: SpaceInheritanceInput) {
  return { follow: (input.space?.sourceSelections?.groups?.['mcp'] ?? (input.space?.inherit.mcp !== false ? 'follow' : 'fixed')) === 'follow', selections: input.space?.sourceSelections?.selections };
}

export function resolveSpaceInheritance(input: SpaceInheritanceInput): SpaceInheritance {
  const inherit = input.space?.inherit;
  const baseHomeDir = input.space?.resourceBaseHomeDir ?? input.baseHomeDir;
  const selections = input.space?.sourceSelections?.selections;
  const follows = (domain: string) => Object.entries(selections ?? {}).some(([id, item]) => id.startsWith(`resource:${domain}:`) && item.mode === 'follow' && item.excluded !== true);
  const active = baseHomeDir !== undefined;
  return {
    baseHomeDir,
    agents: active && (inherit?.agents !== false || follows('agents')),
    instructions: active ? inherit?.instructions === 'stack' ? 'stack' : inherit?.instructions !== false || follows('instructions') : false,
    skills: active && (inherit?.skills !== false || follows('skills')),
    mcp: active && (inherit?.mcp !== false || follows('mcp')),
    appearance: active && (inherit?.appearance !== false || follows('appearance')),
    plugins: active && (inherit?.plugins === true || follows('plugins')),
    genericRoots: inherit?.genericRoots !== false,
  };
}
