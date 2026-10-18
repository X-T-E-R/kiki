import { createContext, useContext } from 'react';

export interface SidebarContextValue {
  readonly sidebarOpen: boolean;
  readonly toggleSidebar?: () => void;
  readonly closeSidebar?: () => void;
}

export const SidebarContext = createContext<SidebarContextValue>({
  sidebarOpen: false,
});

export function useSidebarContext(): SidebarContextValue {
  return useContext(SidebarContext);
}
