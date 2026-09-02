import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { Error2, ErrorCodes } from '#/errors';

export const EXTERNAL_PERMISSION_CEILING_ENV = 'KIKI_EXTERNAL_PERMISSION_CEILING';

const PERMISSION_MODE_RANK: Readonly<Record<PermissionMode, number>> = {
  manual: 0,
  auto: 1,
  yolo: 2,
};

export function resolveExternalPermissionCeiling(
  getEnv: (name: string) => string | undefined,
): PermissionMode {
  const raw = getEnv(EXTERNAL_PERMISSION_CEILING_ENV)?.trim();
  if (raw === undefined || raw === '') return 'manual';
  if (raw === 'manual' || raw === 'auto' || raw === 'yolo') return raw;
  throw new Error2(
    ErrorCodes.VALIDATION_FAILED,
    `${EXTERNAL_PERMISSION_CEILING_ENV} must be one of manual, auto, or yolo, got ${JSON.stringify(raw)}.`,
    { details: { value: raw } },
  );
}

export function constrainExternalPermissionMode(
  mode: PermissionMode,
  ceiling: PermissionMode,
): PermissionMode {
  return PERMISSION_MODE_RANK[mode] <= PERMISSION_MODE_RANK[ceiling] ? mode : ceiling;
}
