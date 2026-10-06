/**
 * On-demand transcript detail — lets timeline rows and media thumbnails read
 * the canonical body of an entity the windowed reset summarized (a task
 * output tail, an attachment without its source, a long prompt).
 *
 * The owning workspace provides the reader and the per-agent load states;
 * rows only ask for "the full thing" and render loading / error / retry.
 *
 * The same provider carries the agent's bounded-content refs: an entity the
 * server had to cut arrives with the offsets it did send, and each ref reads
 * one more segment of that one field. Both readers publish through the same
 * `detailLoads` map (`content:<ref JSON>` for segments), so a row's loading
 * and error state is the controller's own, never a second local one.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useMemo, type ReactNode } from 'react';
import type { SessionController } from '@kiki/session-core/session';

import {
  transcriptDetailKey,
  type TranscriptDetailKind,
  type TranscriptDetailStatus,
} from '@kiki/session-core/session';
import type { ContentRef, ContentSource, TranscriptDetailListResponse } from '@kiki/transcript';

interface TranscriptDetailApi {
  readonly controller: SessionController | undefined;
  readonly load: (agentId: string, kind: TranscriptDetailKind, id: string) => Promise<boolean>;
  /** Load states of the agent this timeline renders. */
  readonly loads: Readonly<Record<string, TranscriptDetailStatus>>;
  /** Bounded fields of the agent this timeline renders, in wire order. */
  readonly contentRefs: readonly ContentRef[];
  /** The session and agent whose canonical bodies these refs address. */
  readonly session: { readonly sessionId: string; readonly agentId: string } | undefined;
  /** Reads one segment of one ref into that same agent's canonical body. */
  readonly loadContent: ((ref: ContentRef) => Promise<boolean>) | undefined;
  /** Reads one page of a windowed entity collection (tasks, prompts, …). */
  readonly loadEntities: ((kind: TranscriptEntityKind) => Promise<boolean>) | undefined;
}

export type TranscriptEntityKind = TranscriptDetailListResponse['kind'];

const TranscriptDetailContext = createContext<TranscriptDetailApi | null>(null);

const NO_REFS: readonly ContentRef[] = [];

export function TranscriptDetailProvider({
  controller,
  load,
  loads,
  contentRefs,
  sessionId,
  agentId,
  loadContent,
  loadEntities,
  children,
}: {
  readonly controller?: SessionController;
  readonly load: TranscriptDetailApi['load'];
  readonly loads: TranscriptDetailApi['loads'];
  /** Absent on read-only surfaces: content rows then render nothing. */
  readonly contentRefs?: readonly ContentRef[];
  /** The session and agent the rows below belong to; used by original-file reads. */
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly loadContent?: TranscriptDetailApi['loadContent'];
  readonly loadEntities?: TranscriptDetailApi['loadEntities'];
  readonly children: ReactNode;
}) {
  // The target is an object so a row can compare it by identity: a new
  // `{sessionId, agentId}` per render would make every read look like a
  // switched target.
  const session = useMemo(
    () => sessionId === undefined || agentId === undefined ? undefined : { sessionId, agentId },
    [sessionId, agentId],
  );
  const value = useMemo(
    () => ({ controller, load, loads, contentRefs: contentRefs ?? NO_REFS, session, loadContent, loadEntities }),
    [controller, load, loads, contentRefs, session, loadContent, loadEntities],
  );
  return <TranscriptDetailContext.Provider value={value}>{children}</TranscriptDetailContext.Provider>;
}

/** The session and agent this timeline renders, when the owner provided them. */
export function useTranscriptTarget(): { readonly sessionId: string; readonly agentId: string } | undefined {
  return useContext(TranscriptDetailContext)?.session;
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

/** The canonical entity a rendered body came from, field for field. */
export interface ContentBodySource {
  readonly kind: ContentSource['kind'];
  readonly id: string;
  readonly turnId?: string;
  readonly stepId?: string;
}

/**
 * `detailLoads` key of one content segment — the controller's own key, so a
 * row reads the state of the request it actually made.
 */
export function contentSegmentKey(ref: ContentRef): string {
  return `content:${JSON.stringify(ref)}`;
}

export interface ContentContinuationHandle {
  /** Unread refs under this body's path roots, in wire order. */
  readonly pending: readonly ContentRef[];
  readonly statusOf: (ref: ContentRef) => TranscriptDetailStatus | undefined;
  readonly request: (ref: ContentRef) => void;
}

/** Reading and load state of one pending ref list, however it was selected. */
function useContinuationFor(pending: readonly ContentRef[]): ContentContinuationHandle {
  const api = useContext(TranscriptDetailContext);
  const statusOf = useCallback(
    (ref: ContentRef) => api?.loads[contentSegmentKey(ref)],
    [api],
  );
  const request = useCallback((ref: ContentRef) => { void api?.loadContent?.(ref); }, [api]);
  return { pending, statusOf, request };
}

/**
 * Bounded fields of one body. Matching is by the entity the body was rendered
 * from (kind + id + the frame's turn and step) plus the field-path root the
 * reading area shows — never by tool name or by position in a list.
 */
export function useContentContinuation(
  source: ContentBodySource | undefined,
  roots: readonly string[],
  callerAgentId?: string,
): ContentContinuationHandle {
  const api = useContext(TranscriptDetailContext);
  const kind = source?.kind;
  const id = source?.id;
  const turnId = source?.turnId;
  const stepId = source?.stepId;
  const pending = useMemo(() => {
    if (api === null || kind === undefined || id === undefined) return NO_REFS;
    const agentId = callerAgentId ?? api.session?.agentId;
    const refs = api.controller !== undefined && agentId !== undefined ? api.controller.contentRefsFor(agentId, { kind, id, turnId, stepId }) : api.contentRefs;
    return refs.filter((ref) =>
      ref.source.kind === kind &&
      ref.source.id === id &&
      ref.source.turnId === turnId &&
      ref.source.stepId === stepId &&
      ref.path.length > 0 &&
      roots.includes(String(ref.path[0])) &&
      (ref.path[0] !== 'steps' || ref.path.length === 1 || ref.path.length === 3 && ref.path[2] === 'frames'),
    );
  }, [api, kind, id, turnId, stepId, roots, callerAgentId]);
  const continuation = useContinuationFor(pending);
  const statusOf = useCallback((ref: ContentRef) => {
    const agentId = callerAgentId ?? api?.session?.agentId;
    return api?.controller !== undefined && agentId !== undefined && agentId !== api.session?.agentId ? api.controller.getAgentState(agentId).detailLoads[contentSegmentKey(ref)] : continuation.statusOf(ref);
  }, [api, callerAgentId, continuation]);
  return { ...continuation, statusOf };
}

/**
 * Snapshot fields a screen actually shows, as `path` prefixes: the title and the
 * cwd beside it (`SessionTitle`), the model and profile in the composer and
 * header (`applyTranscriptShell` puts them on the view state), and the subagent
 * roster. The session object itself is visible only when the cut field is one
 * of those.
 *
 * The `session` root alone is not enough: its `metadata` is a catchall, so a
 * legal custom key (`session.metadata.review_unused_metadata`) can be cut and
 * still have no consumer anywhere in the client — a control for it would report
 * "session content not loaded yet" for a value no screen can show, and would
 * turn an empty session into "pending". Anything not named here is therefore
 * not offered and does not count as pending.
 */
const VISIBLE_SNAPSHOT_PATHS: readonly (readonly string[])[] = [
  ['session', 'title'],
  ['session', 'cwd'],
  ['session', 'metadata', 'cwd'],
  ['session', 'worktree'],
  ['session', 'agent_config'],
  ['session', 'delivery'],
  ['subagents'],
];

/**
 * True for a snapshot ref whose field some screen shows. Matched as a path
 * prefix, so a ref on a whole visible object (`session.agent_config`) keeps its
 * outlet while a ref on one of its own leaves does too.
 */
function showsSnapshotField(ref: ContentRef): boolean {
  return VISIBLE_SNAPSHOT_PATHS.some((visible) =>
    visible.every((key, index) => String(ref.path[index]) === key));
}

/**
 * Unread refs of whole structures: the session snapshot's visible fields, and
 * the agent roster the list is built from. Selected by what the ref would change
 * on screen — never by source kind alone, and never by position.
 */
export function useSessionRemainderRefs(): ContentContinuationHandle {
  const api = useContext(TranscriptDetailContext);
  const pending = useMemo(() => {
    if (api === null) return NO_REFS;
    return api.contentRefs.filter((ref) =>
      ref.source.kind === 'roster' || (ref.source.kind === 'snapshot' && showsSnapshotField(ref)));
  }, [api]);
  return useContinuationFor(pending);
}

/** `detailLoads` key of one entity-collection page — the controller's own key. */
export function entityPageKey(kind: TranscriptEntityKind): string {
  return `entities:${kind}`;
}

export interface EntityPageHandle {
  readonly status: TranscriptDetailStatus | undefined;
  /** Reads the next page of this collection; each call is one page. */
  readonly request: () => void;
}

/**
 * One page of a windowed entity collection (a rail list whose coverage says
 * more exist). The controller folds the page into the same canonical store, so
 * a row that was already shown is never overwritten by a page read.
 */
export function useEntityPage(kind: TranscriptEntityKind): EntityPageHandle {
  const api = useContext(TranscriptDetailContext);
  const request = useCallback(() => { void api?.loadEntities?.(kind); }, [api, kind]);
  return { status: api?.loads[entityPageKey(kind)], request };
}

export function useTranscriptController(): SessionController | undefined {
  return useContext(TranscriptDetailContext)?.controller;
}

export function useAutomaticContentRead(source: ContentBodySource | undefined, roots: readonly string[], callerAgentId?: string): () => void {
  const api = useContext(TranscriptDetailContext);
  const lease = useRef<ReturnType<SessionController['beginContentRead']> | undefined>(undefined);
  const sourceKey = JSON.stringify(source);
  const rootsKey = JSON.stringify(roots);
  const controller = api?.controller;
  const agentId = callerAgentId ?? api?.session?.agentId;
  useEffect(() => {
    if (controller === undefined || sourceKey === undefined || agentId === undefined) return;
    const read = controller.beginContentRead(agentId, JSON.parse(sourceKey) as ContentSource, JSON.parse(rootsKey) as string[]);
    lease.current = read;
    return () => { read.release(); lease.current = undefined; };
  }, [controller, sourceKey, rootsKey, agentId]);
  return useCallback(() => { lease.current?.retry(); }, []);
}
