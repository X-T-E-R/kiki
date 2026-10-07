import { mergeModelSteeringSources, type PatchModelRequest } from '@kiki/protocol';
import { selectCognitionConfig } from '#/agent/cognition/cognitionConfig';
import type { CognitionConfig } from '#/kosong/model/model';

export function patchModelSteeringSources(cognition: CognitionConfig | undefined, patch: NonNullable<PatchModelRequest['steering_sources_patch']>): CognitionConfig {
  const next = structuredClone(cognition ?? {});
  for (const scope of ['common', 'main', 'independent'] as const) {
    const value = patch[scope];
    if (value === undefined) continue;
    if (scope === 'common') {
      next.steeringSources = value === null ? undefined : mergeModelSteeringSources(next.steeringSources, value);
      continue;
    }
    const selected = typeof next[scope] === 'object' ? next[scope] : selectCognitionConfig(next, scope);
    if (value === null && typeof next[scope] !== 'object') continue;
    const branch = { ...selected, steeringSources: value === null ? undefined : mergeModelSteeringSources(selected?.steeringSources, value) };
    next[scope] = Object.values(branch).some((field) => field !== undefined) ? branch : 'off';
  }
  return next;
}
