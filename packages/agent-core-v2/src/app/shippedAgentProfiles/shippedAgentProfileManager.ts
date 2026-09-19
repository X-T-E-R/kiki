import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type ShippedAgentProfileStatus =
  | 'clean'
  | 'custom'
  | 'update-available'
  | 'removed'
  | 'adopted'
  | 'unmanaged'
  | 'disabled'
  | 'retired';

export interface ShippedAgentProfileStatusEntry {
  readonly templateId: string;
  readonly status: ShippedAgentProfileStatus;
  readonly managed: boolean;
  readonly activePath: string | undefined;
  readonly baselineHash: string | undefined;
  readonly activeHash: string | undefined;
  readonly offeredHash: string | undefined;
}

export interface IShippedAgentProfileManager {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<void>;
  status(): Promise<readonly ShippedAgentProfileStatusEntry[]>;
  restoreOriginal(templateId: string): Promise<ShippedAgentProfileStatusEntry>;
}

export const IShippedAgentProfileManager =
  createDecorator<IShippedAgentProfileManager>('shippedAgentProfileManager');
