/**
 * Mount point for the right rail's two modes (prototype): the reordered
 * default rail and the cockpit. A drop-in for RightRail with the same props.
 *
 * Opt-in while the prototype is under review: until `kiki.railMode` is set
 * (the mode switch, or localStorage), the current rail renders unchanged so
 * other screens' proofs and tests are unaffected.
 */

import { RightRail as CurrentRail } from '../RightRail';
import { CockpitRail } from './CockpitRail';
import { DefaultRail } from './DefaultRail';
import { useRailMode, type ModeProps } from './shell';

export function RightRail(props: Omit<ModeProps, 'mode' | 'onChooseMode'>) {
  const [mode, choose, optedIn] = useRailMode();
  if (!optedIn) return <CurrentRail {...props} />;
  const shared: ModeProps = { ...props, mode, onChooseMode: choose };
  return mode === 'cockpit' ? <CockpitRail {...shared} /> : <DefaultRail {...shared} />;
}
