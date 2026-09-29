/**
 * Mount point for the right-rail design variants (prototype). A drop-in for
 * RightRail with the same props: with no variant selected it renders the
 * current rail untouched; `?rail=a|b|c|d` swaps in a variant, `?rail=off`
 * goes back. Every variant opens agents through `onOpenSubagent`.
 */

import type { ComponentProps } from 'react';

import { RightRail as CurrentRail } from '../RightRail';
import { useRailVariant, type RailVariant } from './shell';
import { SwimlaneRail } from './SwimlaneRail';
import { CockpitRail } from './CockpitRail';
import { InboxRail } from './InboxRail';
import { StreamRail } from './StreamRail';

export type RailProps = ComponentProps<typeof CurrentRail>;

/** What every variant receives: the rail props plus the picker. */
export interface VariantProps extends RailProps {
  readonly variant: RailVariant;
  readonly onChooseVariant: (next: RailVariant | undefined) => void;
}

export function RightRail(props: RailProps) {
  const [variant, choose] = useRailVariant();
  if (variant === undefined) return <CurrentRail {...props} />;
  const shared: VariantProps = { ...props, variant, onChooseVariant: choose };
  switch (variant) {
    case 'a':
      return <SwimlaneRail {...shared} />;
    case 'b':
      return <CockpitRail {...shared} />;
    case 'c':
      return <InboxRail {...shared} />;
    case 'd':
      return <StreamRail {...shared} />;
  }
}
