import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { sessionTitleModelPatch } from '@kiki/session-core/settings';
import type { KikiConfigPatch, KikiConfigResponse } from '@kiki/session-core/transport';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { buildCatalogModelOptions } from '../modelSelectOptions';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { Hint } from '../controls';

export interface SessionTitleModelControlsProps {
  onDirtyChange?: (dirty: boolean) => void;
  registerExtraSaver?: (saver: {
    getPatch: () => KikiConfigPatch | null;
    onSaved: (echoed: KikiConfigResponse) => void;
  }) => void;
}

export function SessionTitleModelControls({
  onDirtyChange,
  registerExtraSaver,
}: SessionTitleModelControlsProps) {
  const { client } = useConnection();
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string>('');

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
    }
  }, [configQuery.data, dirty]);

  useEffect(() => {
    if (registerExtraSaver) {
      registerExtraSaver({
        getPatch: () => {
          if (draft === null || draft === baseline) return null;
          return sessionTitleModelPatch(draft);
        },
        onSaved: (echoed) => {
          const nextModel = echoed.session_title?.model ?? '';
          setDraft(nextModel);
          setBaseline(nextModel);
        },
      });
    }
  }, [draft, baseline, registerExtraSaver]);

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
            value={selectedValue}
            options={modelOptions}
            allowCustomValue
            searchPlaceholder={t('st.sessionTitleModel.placeholder')}
            ariaLabel={t('st.sessionTitleModel.model')}
            emptyText={t('st.sessionTitleModel.managedDefault')}
            onChange={(next) => {
              setDraft(next);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** Legacy compat wrapper for backwards compatibility if referenced */
export { SessionTitleModelControls as SessionTitleModelFields };
