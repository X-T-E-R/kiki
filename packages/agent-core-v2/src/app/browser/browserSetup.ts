import { createDecorator } from '#/_base/di/instantiation';
import type { BrowserStatus } from './browser';

export type BrowserPresetId = 'kimi-webbridge' | 'independent-browser' | 'codex-browser';
export interface BrowserSetupStep {
  readonly id: string;
  readonly state: 'ready' | 'missing' | 'running' | 'user_action' | 'failed' | 'warning';
  readonly reason?: string;
  readonly detail?: string;
  readonly percent?: number;
}
export interface BrowserSetupAction {
  readonly id: 'prepare' | 'connect' | 'cancel' | 'install_extension' | 'open_instructions' | 'enable_feature' | 'choose_connection';
  readonly url?: string;
  readonly target?: 'chrome' | 'edge' | 'documentation';
}
export interface BrowserSetupStatus {
  readonly preset: BrowserPresetId;
  readonly displayName: string;
  readonly controlSurface: 'plugin-skill' | 'browser-connection' | 'external-app';
  readonly state: 'not_prepared' | 'preparing' | 'needs_user_action' | 'ready' | 'connected' | 'failed' | 'external_only' | 'unsupported';
  readonly supported: boolean;
  readonly executionHost: string;
  readonly steps: readonly BrowserSetupStep[];
  readonly actions: readonly BrowserSetupAction[];
  readonly pluginId?: string;
  readonly skill?: string;
  readonly capabilityId?: string;
  readonly connectionId?: string;
  readonly connection?: BrowserStatus;
  readonly checkedAt?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly sourceUrl: string;
}
export interface BrowserSetupConnectInput {
  readonly connectionId?: string;
  readonly name?: string;
  readonly setDefault?: boolean;
}
export interface IBrowserSetupService {
  readonly _serviceBrand: undefined;
  list(): Promise<{ readonly presets: readonly BrowserSetupStatus[] }>;
  status(preset: BrowserPresetId): Promise<BrowserSetupStatus>;
  prepare(preset: BrowserPresetId, input: { readonly consent: true }): Promise<BrowserSetupStatus>;
  connect(preset: BrowserPresetId, input: BrowserSetupConnectInput): Promise<BrowserSetupStatus>;
  cancel(preset: BrowserPresetId): Promise<BrowserSetupStatus>;
}
export const IBrowserSetupService = createDecorator<IBrowserSetupService>('browserSetupService');
