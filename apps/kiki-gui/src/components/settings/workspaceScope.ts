import { createContext } from 'react';

/**
 * Sections with workspace-scoped surfaces (today: Capabilities' MCP card;
 * batches 2/3 add the MCP/Skills pages) report the workspace their edits
 * currently target, so the page scope header can name it ("Workspace · <name>")
 * instead of leaving the scope abstract. The page owns the state; the section
 * reports on selection change and clears on unmount.
 */
export const SettingsWorkspaceScopeContext = createContext<(name: string | null) => void>(() => {});

/**
 * One workspace's own page reports the workspace it is showing, so the
 * settings breadcrumb can name the object the way an open plugin's page names
 * its plugin. A page that IS an object says which one; a section that merely
 * edits one says nothing here and the section label stands.
 */
export const WorkspaceDetailNameContext = createContext<(name: string | null) => void>(() => {});
