import { createContext, useContext } from 'react';

export interface PendingInteractionRef {
  readonly kind: 'approval' | 'question';
  readonly id: string;
}

export interface InteractionPlacement {
  readonly inTray: boolean;
  readonly onReview?: (kind: 'approval' | 'question', id: string) => void;
  /** Pending items in the tray's handling order, so phone timelines can name the batch once. */
  readonly pendingItems?: readonly PendingInteractionRef[];
}

export const InteractionPlacementContext = createContext<InteractionPlacement>({ inTray: false });

export function useInteractionPlacement(): InteractionPlacement {
  return useContext(InteractionPlacementContext);
}
