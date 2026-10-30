/**
 * The 模型使用倾向 control's own write path: the picked value shows at once
 * while the PATCH is written, a refused write falls back to the stored value,
 * and a stale answer never lands on top of a newer pick or a different scope.
 * Extracted so the section can move the control into the 高级 fold without
 * carrying its bookkeeping along.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { computerControlPreference, computerControlPreferencePatch } from '@kiki/session-core/settings';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import type { Feedback } from '../../controls';
import { useSavedTick } from '../useSavedTick';

type ComputerUsagePreference = ReturnType<typeof computerControlPreference>;

export function useComputerPreference(configQuery: { data: unknown; isPending: boolean; isError: boolean; error: unknown; refetch: () => Promise<unknown> }) {
  const { client, scopeId } = useConnection();
  const { locale } = useI18n();
  const queryClient = useQueryClient();

  const effectivePreference = (configQuery.data as Parameters<typeof computerControlPreference>[0] | undefined) !== undefined
    ? computerControlPreference(configQuery.data as Parameters<typeof computerControlPreference>[0])
    : 'avoid';
  const preferenceSource = (configQuery.data as { computer_control?: { usagePreferenceSource?: string } } | undefined)?.computer_control?.usagePreferenceSource ?? 'default';
  const isOverriddenByHigherSource = preferenceSource === 'env' || preferenceSource === 'memory';

  const [draftPreference, setDraftPreference] = useState<ComputerUsagePreference | null>(null);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [preferenceFeedback, setPreferenceFeedback] = useState<Feedback>(null);
  const [preferenceSaved, pingPreferenceSaved] = useSavedTick();
  const [savedGeneration, setSavedGeneration] = useState(0);
  const scopeGenerationRef = useRef(0);
  const nextPreferenceRequestRef = useRef(0);
  const latestPreferenceRequestsRef = useRef(new Map<string, number>());

  useEffect(() => {
    scopeGenerationRef.current += 1;
    setDraftPreference(null);
    setPreferenceSaving(false);
    setPreferenceFeedback(null);
    return () => { scopeGenerationRef.current += 1; };
  }, [scopeId]);

  const isPreferenceSaved = preferenceSaved && savedGeneration === scopeGenerationRef.current;
  /** The pick shows at once while it is written; a refused write falls back to the stored value. */
  const activePreference = draftPreference ?? effectivePreference;

  const persistPreference = async (targetPreference: ComputerUsagePreference | null) => {
    const targetScopeId = scopeId;
    const requestGen = scopeGenerationRef.current;
    const requestId = ++nextPreferenceRequestRef.current;
    latestPreferenceRequestsRef.current.set(targetScopeId, requestId);
    const isLatestRequest = () => latestPreferenceRequestsRef.current.get(targetScopeId) === requestId;
    const ownsCurrentUi = () => isLatestRequest() && scopeGenerationRef.current === requestGen;

    setPreferenceSaving(true);
    setPreferenceFeedback(null);
    try {
      const queryKey = ['config', targetScopeId] as const;
      const dataUpdateCount = queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0;
      const echoed = await client.patchConfig(computerControlPreferencePatch(targetPreference));
      if (!isLatestRequest()) return;
      // A newer write to the same cache entry outranks this answer: another
      // pick landed while this one was in flight, so its echo is stale.
      if ((queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0) !== dataUpdateCount) return;
      queryClient.setQueryData(queryKey, echoed);
      if (ownsCurrentUi()) {
        setDraftPreference(null);
        setSavedGeneration(requestGen);
        pingPreferenceSaved();
      }
      return echoed;
    } catch (error) {
      if (ownsCurrentUi()) {
        setDraftPreference(null);
        setPreferenceFeedback({ tone: 'error', text: errorText(locale, error) });
      }
      return undefined;
    } finally {
      if (ownsCurrentUi()) {
        setPreferenceSaving(false);
      }
    }
  };

  const choosePreference = (next: ComputerUsagePreference) => {
    if (isOverriddenByHigherSource || preferenceSaving || next === activePreference) return;
    setDraftPreference(next);
    void persistPreference(next);
  };

  const resetToInherited = async () => {
    if (isOverriddenByHigherSource || preferenceSaving) return;
    await persistPreference(null);
  };

  return {
    activePreference,
    preferenceSource,
    isOverriddenByHigherSource,
    preferenceSaving,
    preferenceFeedback,
    isPreferenceSaved,
    choosePreference,
    resetToInherited,
  };
}
