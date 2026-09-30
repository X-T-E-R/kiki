/**
 * Session inspector — the right panel (open by default on wide windows; see
 * `railOpenByDefault`). It describes ONE agent at a time, whichever the user
 * last clicked into or focused (see inspectorFocus.ts). The main agent and
 * every subagent get the same page (rail-variants/Rail.tsx); only its 概览
 * block switches between the standard figures and the cockpit instruments.
 */

export { Rail as RightRail } from './rail-variants/Rail';
export type { InspectorMemorySlot, RailProps, SubagentRailContext } from './rail-variants/types';
