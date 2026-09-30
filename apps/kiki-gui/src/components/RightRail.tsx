/**
 * Session inspector — the right panel (open by default on wide windows; see
 * `railOpenByDefault`). It describes ONE agent at a time, whichever the user
 * last clicked into or focused (see inspectorFocus.ts), in one of two modes:
 *
 *   default   the coordinator's reading order: needs you, now, context and
 *             cost, the team, the checklist, then folded reference
 *             (rail-variants/DefaultRail.tsx)
 *   cockpit   an instrument panel: caution bar, gauges, the agent array and
 *             what is running (rail-variants/CockpitRail.tsx)
 *
 * The mode is a device preference (`kiki.railMode`), chosen from the switch
 * in the rail head; with nothing chosen the rail opens in the default mode.
 */

import { CockpitRail } from './rail-variants/CockpitRail';
import { DefaultRail } from './rail-variants/DefaultRail';
import { useRailMode, type ModeProps } from './rail-variants/shell';
import type { RailProps } from './rail-variants/types';

export type { InspectorMemorySlot, RailProps, SubagentRailContext } from './rail-variants/types';

export function RightRail(props: RailProps) {
  const [mode, choose] = useRailMode();
  const shared: ModeProps = { ...props, mode, onChooseMode: choose };
  return mode === 'cockpit' ? <CockpitRail {...shared} /> : <DefaultRail {...shared} />;
}
