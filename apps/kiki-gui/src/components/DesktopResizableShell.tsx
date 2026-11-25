import { useRef, type ReactNode } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '@kiki/session-core/settings';

import { persistSidebarPanelWidth } from '../lib/panelLayoutStorage';

export interface DesktopResizableShellProps {
  readonly defaultSidebarWidth: number;
  readonly resizeAriaLabel: string;
  readonly sidebar: ReactNode;
  readonly stage: ReactNode;
}

export function DesktopResizableShell({
  defaultSidebarWidth,
  resizeAriaLabel,
  sidebar,
  stage,
}: DesktopResizableShellProps) {
  const sidebarPanelRef = usePanelRef();
  const latestSidebarPixelsRef = useRef<number | null>(null);

  return (
    <Group
      orientation="horizontal"
      id="kiki-shell"
      className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas"
      onLayoutChanged={() => {
        if (latestSidebarPixelsRef.current !== null && latestSidebarPixelsRef.current >= SIDEBAR_MIN_WIDTH) {
          persistSidebarPanelWidth(latestSidebarPixelsRef.current);
        }
      }}
    >
      <Panel
        id="sidebar"
        panelRef={sidebarPanelRef}
        defaultSize={defaultSidebarWidth}
        minSize={SIDEBAR_MIN_WIDTH}
        maxSize={SIDEBAR_MAX_WIDTH}
        onResize={(size) => {
          if (size.inPixels >= SIDEBAR_MIN_WIDTH) {
            latestSidebarPixelsRef.current = size.inPixels;
          }
        }}
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
        style={{ overflow: 'hidden' }}
      >
        {sidebar}
      </Panel>
      <Separator
        id="kiki-shell-resizer"
        data-sidebar-resizer=""
        aria-label={resizeAriaLabel}
        title={resizeAriaLabel}
        className="kiki-panel-separator"
        onPointerDown={() => {
          document.body.dataset['paneResizing'] = 'true';
          const clear = () => {
            delete document.body.dataset['paneResizing'];
            window.removeEventListener('pointerup', clear);
            window.removeEventListener('pointercancel', clear);
            window.removeEventListener('blur', clear);
          };
          window.addEventListener('pointerup', clear);
          window.addEventListener('pointercancel', clear);
          window.addEventListener('blur', clear);
        }}
        onDoubleClick={() => {
          sidebarPanelRef.current?.resize(SIDEBAR_DEFAULT_WIDTH);
          latestSidebarPixelsRef.current = SIDEBAR_DEFAULT_WIDTH;
          persistSidebarPanelWidth(SIDEBAR_DEFAULT_WIDTH);
        }}
      />
      <Panel id="stage" minSize={480} className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" style={{ overflow: 'hidden' }}>
        {stage}
      </Panel>
    </Group>
  );
}
