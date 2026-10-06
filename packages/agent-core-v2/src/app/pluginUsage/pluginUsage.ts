import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type PluginUsageOverride = 'inherit' | 'on' | 'off';
export interface PluginUsageSnapshot {
  readonly workspaceId: string;
  readonly revision: number;
  readonly overrides: Readonly<Record<string, boolean>>;
  readonly applyState: 'applied' | 'pending' | 'failed';
  readonly errors: readonly string[];
}
export interface PluginUsageChange {
  readonly workspaceId: string;
  readonly pluginId: string;
  readonly revision: number;
  waitUntil(work: Promise<unknown>): void;
}
export interface IPluginUsageService {
  readonly _serviceBrand: undefined;
  enabled(): boolean;
  read(workspaceId: string): Promise<PluginUsageSnapshot>;
  allows(workspaceId: string | undefined, pluginId: string): Promise<boolean>;
  set(input: { workspaceId: string; pluginId: string; override: PluginUsageOverride }): Promise<PluginUsageSnapshot>;
  readonly onDidChange: Event<PluginUsageChange>;
  readonly onDidApply: Event<PluginUsageSnapshot>;
}
export const IPluginUsageService = createDecorator<IPluginUsageService>('pluginUsageService');
