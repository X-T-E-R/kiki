/**
 * On-demand transcript detail — lets timeline rows and media thumbnails read
 * the canonical body of an entity the windowed reset summarized (a task
 * output tail, an attachment without its source, a long prompt).
 *
 * The owning workspace provides the reader and the per-agent load states;
 * rows only ask for "the full thing" and render loading / error / retry.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

import {
  transcriptDetailKey,
  type TranscriptDetailKind,
  type TranscriptDetailStatus,
} from '@kiki/session-core/session';

interface TranscriptDetailApi {
  readonly load: (agentId: string, kind: TranscriptDetailKind, id: string) => Promise<boolean>;
  /** Load states of the agent this timeline renders. */
  readonly loads: Readonly<Record<string, TranscriptDetailStatus>>;
}

const TranscriptDetailContext = createContext<TranscriptDetailApi | null>(null);

export function TranscriptDetailProvider({
  load,
  loads,
  children,
}: TranscriptDetailApi & { readonly children: ReactNode }) {
  const value = useMemo(() => ({ load, loads }), [load, loads]);
  return <TranscriptDetailContext.Provider value={value}>{children}</TranscriptDetailContext.Provider>;
}

export interface TranscriptDetailHandle {
  /** Undefined outside a provider (read-only surfaces): the row keeps its summary. */
  readonly request: (() => void) | undefined;
  readonly status: TranscriptDetailStatus | undefined;
}

/** Reader for one entity; `ref` undefined means the row already has the full body. */
export function useTranscriptDetail(
  ref: { readonly agentId: string; readonly kind: TranscriptDetailKind; readonly id: string } | undefined,
): TranscriptDetailHandle {
  const api = useContext(TranscriptDetailContext);
  const agentId = ref?.agentId;
  const kind = ref?.kind;
  const id = ref?.id;
  const request = useCallback(() => {
    if (api === null || agentId === undefined || kind === undefined || id === undefined) return;
    void api.load(agentId, kind, id);
  }, [api, agentId, kind, id]);
  if (api === null || kind === undefined || id === undefined) return { request: undefined, status: undefined };
  return { request, status: api.loads[transcriptDetailKey(kind, id)] };
}
