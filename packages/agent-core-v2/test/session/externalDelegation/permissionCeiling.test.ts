import { describe, expect, it } from 'vitest';

import { constrainPermissionMode } from '#/agent/permissionMode/permissionMode';
import { resolveExternalPermissionCeiling } from '#/session/externalDelegation/permissionCeiling';

describe('external delegation permission ceiling', () => {
  const ceiling = (value?: string) => resolveExternalPermissionCeiling((name) => (name === 'KIKI_EXTERNAL_PERMISSION_CEILING' ? value : undefined));

  it('accepts every permission mode, review included, and defaults to manual', () => {
    expect(ceiling()).toBe('manual');
    for (const mode of ['manual', 'auto', 'review', 'yolo'] as const) expect(ceiling(mode)).toBe(mode);
    expect(() => ceiling('everything')).toThrow(/manual, auto, review, or yolo/);
  });

  it('lets a review seat run under a review or yolo ceiling and caps it under auto', () => {
    expect(constrainPermissionMode('review', ceiling('review'))).toBe('review');
    expect(constrainPermissionMode('review', ceiling('yolo'))).toBe('review');
    expect(constrainPermissionMode('review', ceiling('auto'))).toBe('auto');
    expect(constrainPermissionMode('yolo', ceiling('review'))).toBe('review');
  });
});
