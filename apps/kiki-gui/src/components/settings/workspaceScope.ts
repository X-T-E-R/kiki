import { createContext } from 'react';

/**
 * Sections with workspace-scoped surfaces (today: Capabilities' MCP card;
 * batches 2/3 add the MCP/Skills pages) report the workspace their edits
 * currently target, so the page scope header can name it ("Workspace · <name>")
 * instead of leaving the scope abstract. The page owns the state; the section
 * reports on selection change and clears on unmount.
 */
export const SettingsWorkspaceScopeContext = createContext<(name: string | null) => void>(() => {});
