import type { AiSettingsTab } from '@kiki/session-core/settings';
import { lazyPage } from '../LazyPage';
import type { SectionId } from './sections';

export const LazyAboutSection = lazyPage(() => import('./AboutSection').then((m) => m.AboutSection));
export const LazyDesktopLogCard = lazyPage(() => import('./DesktopLogCard').then((m) => m.DesktopLogCard));
export const LazyAppearanceSection = lazyPage(() => import('./AppearanceSection').then((m) => m.AppearanceSection));
export const LazyAgentsSection = lazyPage(() => import('./AgentsSection').then((m) => m.AgentsSection));
export const LazyAiSection = lazyPage<{ resolvedTab?: AiSettingsTab }>(() => import('./AiSection').then((m) => m.AiSection));
export const LazyProvidersSection = lazyPage(() => import('./ProvidersSection').then((m) => m.ProvidersSection));
export const LazyDefaultsTab = lazyPage(() => import('./ModelsSection').then((m) => m.DefaultsTab));
export const LazyEngineParametersSection = lazyPage(() => import('./EngineParametersSection').then((m) => m.EngineParametersSection));
export const LazyHooksSection = lazyPage(() => import('./hooks/HooksSection').then((m) => m.HooksSection));
export const LazyConnectionSection = lazyPage(() => import('./ConnectionSection').then((m) => m.ConnectionSection));
export const LazyDeveloperSection = lazyPage(() => import('./DeveloperSection').then((m) => m.DeveloperSection));
export const LazyExperimentalRows = lazyPage(() => import('./ExperimentalRows').then((m) => m.ExperimentalRows));
export const LazyExtensionsSection = lazyPage(() => import('./ExtensionsSection').then((m) => m.ExtensionsSection));
export const LazyPluginSettingsSectionSlotList = lazyPage(() => import('../plugins/PluginSettingsSectionCard').then((m) => m.PluginSettingsSectionSlotList));
export const LazyConnectionServicesSection = lazyPage(() => import('./ConnectionServicesSection').then((m) => m.ConnectionServicesSection));
export const LazyGeneralSection = lazyPage(() => import('./GeneralSection').then((m) => m.GeneralSection));
export const LazyLabsSection = lazyPage(() => import('./LabsSection').then((m) => m.LabsSection));
export const LazyMcpSection = lazyPage(() => import('./McpSection').then((m) => m.McpSection));
export const LazyMemorySection = lazyPage(() => import('./MemorySection').then((m) => m.MemorySection));
export const LazyNbSearchSection = lazyPage(() => import('./NbSearchSection').then((m) => m.NbSearchSection));
export const LazyIdentitySection = lazyPage(() => import('./IdentitySection').then((m) => m.IdentitySection));
export const LazyNotificationsSection = lazyPage(() => import('./NotificationsSection').then((m) => m.NotificationsSection));
export const LazyPermissionsSection = lazyPage(() => import('./PermissionsSection').then((m) => m.PermissionsSection));
export const LazyPluginsSection = lazyPage(() => import('./PluginsSection').then((m) => m.PluginsSection));
export const LazyBrowserControlSection = lazyPage(() => import('./BrowserControlSection').then((m) => m.BrowserControlSection));
export const LazySessionsSection = lazyPage(() => import('./SessionsSection').then((m) => m.SessionsSection));
export const LazySessionsImportPage = lazyPage(() => import('./SessionsImportPage').then((m) => m.SessionsImportPage));
export const LazyShortcutsSection = lazyPage(() => import('./ShortcutsSection').then((m) => m.ShortcutsSection));
export const LazySkillsSection = lazyPage(() => import('./SkillsSection').then((m) => m.SkillsSection));
export const LazySpacesSection = lazyPage(() => import('./SpacesSection').then((m) => m.SpacesSection));
export const LazySubscriptionsSection = lazyPage(() => import('./SubscriptionsSection').then((m) => m.SubscriptionsSection));
export const LazyTasksSection = lazyPage(() => import('./TasksSection').then((m) => m.TasksSection));
export const LazyWorkspacesSection = lazyPage(() => import('./WorkspacesSection').then((m) => m.WorkspacesSection));
export const LazySshSection = lazyPage(() => import('../ssh/SshSection').then((m) => m.SshSection));

const PRELOADERS: Partial<Record<SectionId, () => void>> = {
  general: () => { LazyGeneralSection.preload(); },
  appearance: () => { LazyAppearanceSection.preload(); },
  shortcuts: () => { LazyShortcutsSection.preload(); },
  connection: () => { LazyConnectionSection.preload(); },
  ai: () => { LazyAiSection.preload(); },
  providers: () => { LazyProvidersSection.preload(); },
  models: () => { LazyDefaultsTab.preload(); },
  'connection-services': () => { LazyConnectionServicesSection.preload(); },
  identity: () => { LazyIdentitySection.preload(); },
  agents: () => { LazyAgentsSection.preload(); },
  subagents: () => { LazyAgentsSection.preload(); },
  sessions: () => { LazySessionsSection.preload(); },
  notifications: () => { LazyNotificationsSection.preload(); },
  memory: () => { LazyMemorySection.preload(); },
  permissions: () => { LazyPermissionsSection.preload(); },
  tasks: () => { LazyTasksSection.preload(); },
  skills: () => { LazySkillsSection.preload(); },
  mcp: () => { LazyMcpSection.preload(); },
  'external-clients': () => { LazyConnectionServicesSection.preload(); },
  plugins: () => { LazyPluginsSection.preload(); },
  'browser-control': () => { LazyBrowserControlSection.preload(); },
  'computer-control': () => { LazyBrowserControlSection.preload(); },
  search: () => { LazyNbSearchSection.preload(); },
  hooks: () => { LazyHooksSection.preload(); },
  subscriptions: () => { LazySubscriptionsSection.preload(); },
  spaces: () => { LazySpacesSection.preload(); },
  workspaces: () => { LazyWorkspacesSection.preload(); },
  ssh: () => { LazySshSection.preload(); },
  developer: () => { LazyDeveloperSection.preload(); },
  labs: () => { LazyLabsSection.preload(); },
  extensions: () => { LazyExtensionsSection.preload(); },
  'environment-tools': () => { LazyNbSearchSection.preload(); LazyBrowserControlSection.preload(); },
  remote: () => { LazyConnectionSection.preload(); LazySshSection.preload(); LazyConnectionServicesSection.preload(); },
  system: () => { LazyDeveloperSection.preload(); LazyAboutSection.preload(); LazyDesktopLogCard.preload(); },
  about: () => { LazyAboutSection.preload(); LazyDesktopLogCard.preload(); },
};

export function preloadSettingsSection(section: SectionId | string | null | undefined): void {
  if (typeof section !== 'string') return;
  PRELOADERS[section as SectionId]?.();
}
