import { createContext, useContext, useMemo, type ReactNode } from 'react';

import {
  resolveModelDisplay,
  type CatalogModelLike,
  type ModelDisplayResult,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';

export interface ModelDisplayContextValue {
  readonly catalog?: readonly CatalogModelLike[];
  readonly scope?: string;
  readonly externalExecutor?: boolean;
}

const ModelDisplayContext = createContext<ModelDisplayContextValue>({});

export function ModelDisplayProvider({
  catalog,
  scope,
  externalExecutor,
  children,
}: ModelDisplayContextValue & { readonly children: ReactNode }) {
  const value = useMemo<ModelDisplayContextValue>(
    () => ({ catalog, scope, externalExecutor }),
    [catalog, scope, externalExecutor],
  );
  return <ModelDisplayContext.Provider value={value}>{children}</ModelDisplayContext.Provider>;
}

export function useResolvedModelDisplay(
  rawId: string | undefined,
  options?: { readonly externalExecutor?: boolean },
): ModelDisplayResult {
  const { t } = useI18n();
  const ctx = useContext(ModelDisplayContext);
  const unknownLabel = t('transcript.error.modelUnknown');
  return useMemo(
    () =>
      resolveModelDisplay(rawId, {
        catalog: ctx.catalog,
        scope: ctx.scope,
        externalExecutor: options?.externalExecutor ?? ctx.externalExecutor,
        unknownLabel,
      }),
    [rawId, ctx.catalog, ctx.scope, ctx.externalExecutor, options?.externalExecutor, unknownLabel],
  );
}
