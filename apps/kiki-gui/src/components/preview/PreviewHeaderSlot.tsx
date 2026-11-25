import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type PreviewWidthTier = 'wide' | 'medium' | 'compact';

export interface PreviewHeaderSlotContextValue {
  /**
   * True when the workspace uses one unified 48 CSS px (h-12) head and
   * absorbs the active tab's outer toolbar controls via portal.
   */
  readonly unifiedHead: boolean;
  /** Actual measured preview pane width in CSS pixels. */
  readonly paneWidth: number;
  /** Container-width action priority tier (>=640 wide, 480-639 medium, <480 or coarse compact). */
  readonly widthTier: PreviewWidthTier;
  /** Portal target inside the 48px head for active-tab controls. */
  readonly actionsSlot: HTMLElement | null;
}

const DEFAULT_HEADER_SLOT: PreviewHeaderSlotContextValue = {
  unifiedHead: false,
  paneWidth: 480,
  widthTier: 'medium',
  actionsSlot: null,
};

const PreviewHeaderSlotContext = createContext<PreviewHeaderSlotContextValue>(DEFAULT_HEADER_SLOT);

export function PreviewHeaderSlotProvider({
  value,
  children,
}: {
  readonly value: PreviewHeaderSlotContextValue;
  readonly children: ReactNode;
}) {
  return (
    <PreviewHeaderSlotContext.Provider value={value}>
      {children}
    </PreviewHeaderSlotContext.Provider>
  );
}

export function usePreviewHeaderSlot(): PreviewHeaderSlotContextValue {
  return useContext(PreviewHeaderSlotContext);
}

export function previewWidthTier(paneWidth: number, phoneMode: boolean): PreviewWidthTier {
  if (phoneMode || paneWidth < 480) return 'compact';
  if (paneWidth < 640) return 'medium';
  return 'wide';
}

/**
 * Portals an active tab's outer toolbar actions into the unified 48px host
 * head without unmounting the tab's body across single <-> multi transitions.
 */
export function PreviewHeaderActionsPortal({
  active,
  children,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  const { unifiedHead, actionsSlot } = usePreviewHeaderSlot();
  if (!active || !unifiedHead || actionsSlot === null) return null;
  return createPortal(children, actionsSlot);
}
