import { createDecorator } from "#/_base/di/instantiation";
import type { Event } from '#/_base/event';
import type { PermissionMode } from '#/agent/permissionPolicy/types';

export interface PermissionModeChangedContext {
  readonly mode: PermissionMode;
  readonly previousMode: PermissionMode;
}

const PERMISSION_MODE_RANK: Readonly<Record<PermissionMode, number>> = {
  manual: 0,
  auto: 1,
  review: 2,
  yolo: 3,
};

export function constrainPermissionMode(
  mode: PermissionMode,
  ceiling: PermissionMode,
): PermissionMode {
  return PERMISSION_MODE_RANK[mode] <= PERMISSION_MODE_RANK[ceiling] ? mode : ceiling;
}

export interface IAgentPermissionModeService {
  readonly _serviceBrand: undefined;

  readonly mode: PermissionMode;
  readonly externalOverride?: PermissionMode;
  readonly modeCeiling?: PermissionMode;
  readonly interactive?: boolean;
  setMode(mode: PermissionMode, source?: 'runtime' | 'ambient' | 'binding'): void;
  setModeCeiling(mode: PermissionMode): void;
  setModeAndBroadcast(mode: PermissionMode): void;

  readonly onDidChangeMode: Event<PermissionModeChangedContext>;
}

export const IAgentPermissionModeService =
  createDecorator<IAgentPermissionModeService>('agentPermissionModeService');
