import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { sessionTitleModelPatch } from '@kiki/session-core/settings';
import type { KikiConfigPatch, KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { Hint } from '../controls';

export interface SessionTitleModelControlsProps {
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  registerExtraSaver?: (saver: {
    getPatch: () => KikiConfigPatch | null;
    onSaved: (echoed: KikiConfigResponse) => void;
  }) => void;
}

export function SessionTitleModelControls({
  disabled = false,
  onDirtyChange,
  registerExtraSaver,
}: SessionTitleModelControlsProps) {
  const { client } = useConnection();
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string>('');

  const revisionRef = useRef(0);
  const savingRevisionRef = useRef<number | null>(null);
  const draftRef = useRef<string | null>(draft);
  draftRef.current = draft;
  const baselineRef = useRef<string>(baseline);
  baselineRef.current = baseline;

  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });

  const dirty = draft !== null && draft !== baseline;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) {
      const serverModel = configQuery.data.session_title?.model ?? '';
      setDraft(serverModel);
      setBaseline(serverModel);
      draftRef.current = serverModel;
      baselineRef.current = serverModel;
    }
  }, [configQuery.data, dirty]);

  const updateDraft = useCallback((next: string) => {
    if (next === draftRef.current) return;
    revisionRef.current += 1;
    draftRef.current = next;
    setDraft(next);
  }, []);

  useEffect(() => {
    if (registerExtraSaver) {
      registerExtraSaver({
        getPatch: () => {
          const currentDraft = draftRef.current;
          const currentBaseline = baselineRef.current;
          if (currentDraft === null || currentDraft === currentBaseline) {
            savingRevisionRef.current = null;
            return null;
          }
          savingRevisionRef.current = revisionRef.current;
          return sessionTitleModelPatch(currentDraft);
        },
        onSaved: (echoed) => {
          const nextModel = echoed.session_title?.model ?? '';
          const savedRevision = savingRevisionRef.current;
          savingRevisionRef.current = null;

          setBaseline(nextModel);
          baselineRef.current = nextModel;

          if (savedRevision !== null && revisionRef.current === savedRevision) {
            setDraft(nextModel);
            draftRef.current = nextModel;
          }
        },
      });
    }
  }, [registerExtraSaver]);

  const models = modelsQuery.data?.items ?? [];
  const modelOptions = useMemo<readonly SearchableSelectOption[]>(() => {
    const defaultOption: SearchableSelectOption = {
      value: '',
      label: t('st.sessionTitleModel.managedDefault'),
      description: t('st.sessionTitleModel.managedDesc'),
    };
    const catalogOptions = buildCatalogModelOptions(models, t);
    return [defaultOption, ...catalogOptions];
  }, [models, t]);

  const selectedValue = draft ?? '';

  return (
    <div className="space-y-2 border-t border-hairline pt-3">
      <Hint>{t('st.sessionTitleModel.hint')}</Hint>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <label htmlFor="session-title-model" className="text-[12px] font-medium text-ink">
          {t('st.sessionTitleModel.model')}
        </label>
        <div className="w-72 max-w-full">
          <SearchableSelect
            id="session-title-model"
            disabled={disabled}
            value={selectedValue}
            options={modelOptions}
            allowCustomValue
            searchPlaceholder={t('st.sessionTitleModel.placeholder')}
            ariaLabel={t('st.sessionTitleModel.model')}
            emptyText={t('st.sessionTitleModel.managedDefault')}
            onChange={updateDraft}
          />
          <input
            type="text"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-session-title-model-input
            value={selectedValue}
            onChange={(event) => {
              updateDraft(event.target.value);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** Legacy compat wrapper for backwards compatibility if referenced */
export { SessionTitleModelControls as SessionTitleModelFields };
