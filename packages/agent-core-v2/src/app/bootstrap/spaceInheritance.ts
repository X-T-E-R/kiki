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

export function resolveSpaceInheritance(input: SpaceInheritanceInput): SpaceInheritance {
  const inherit = input.space?.inherit;
  const baseHomeDir = input.baseHomeDir;
  const active = baseHomeDir !== undefined;
  return {
    baseHomeDir,
    agents: active && inherit?.agents !== false,
    instructions: active ? inherit?.instructions ?? true : false,
    skills: active && inherit?.skills !== false,
    mcp: active && inherit?.mcp !== false,
    appearance: active && inherit?.appearance !== false,
    plugins: active && inherit?.plugins === true,
    genericRoots: inherit?.genericRoots !== false,
  };
}
