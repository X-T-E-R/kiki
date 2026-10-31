/**
 * Agent reference chip — a `kiki://agents/<profile>` link inside a user
 * message, rendered the same way the thread and room chips are: one quiet
 * token in the prose, sized to the line it sits in. The profile and engine
 * are always readable; the delegation status decides the click:
 *
 *   - delegated: the chip opens the run the reference produced. One reference
 *     can run several children over time — the click jumps to the most recent
 *     and, with more than one run, opens a small menu so an earlier run is one
 *     pick away;
 *   - rejected: the run never started, so the chip says so in words and a
 *     strikethrough, not by dot colour alone;
 *   - pending: the reference is still just a mention, so the chip reads as
 *     "not delegated yet" and does not jump anywhere.
 *
 * The chip never invents a child: with no matching task it has no run to open,
 * so a click is a no-op read of the status, not a dead navigation.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { findAgentRefs } from '@kiki/protocol';
import type { Task } from '@kiki/protocol';
import type { AgentReference } from '@kiki/transcript';
import type { I18nKey, I18nParams } from '@kiki/session-core/i18n';
import { agentRefDelegation, type AgentRefDelegation, type AgentRefRun } from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { useOptionalConnection } from '../state/connection';
import { Icon } from './icons';
import { MiniContextMenu } from './MiniContextMenu';
import { engineLabel as catalogEngineLabel, executorCatalogQueryKey } from './settings/profileEditor/engines';

/**
 * What a transcript surface knows for resolving agent references: the task
 * list a delegation lands in, the entry that opens a child run, and the id of
 * the message the chips sit in (a task's `source_ref` names both the ref and
 * its message, so two messages referencing the same profile resolve their own
 * runs). Read-only surfaces leave `onOpenAgent` undefined and the chips stay
 * status reads.
 */
export interface AgentRefResolution {
  readonly tasks: readonly Task[];
  readonly onOpenAgent?: (agentId: string) => void;
}

const AgentRefResolutionContext = createContext<AgentRefResolution | null>(null);

export const AgentRefResolutionProvider = AgentRefResolutionContext.Provider;

/** The resolution the surrounding transcript provided, or null outside one. */
export function useAgentRefResolution(): AgentRefResolution | null {
  return useContext(AgentRefResolutionContext);
}

const INLINE_SHAPE =
  'mx-0.5 inline-flex h-[22px] max-w-[18rem] translate-y-[-1px] items-center gap-1 rounded-md bg-paper/80 px-1.5 align-middle text-[12.5px] leading-none shadow-[inset_0_0_0_1px_var(--color-hairline)]';

function statusDot(status: AgentRefDelegation['status']): ReactNode {
  if (status === 'delegated') return <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full bg-success" />;
  if (status === 'rejected') return <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full bg-danger/70" />;
  return <span aria-hidden className="h-[6px] w-[6px] shrink-0 rounded-full border border-ink-faint/70" />;
}

/** One run-menu entry: how the reader tells it apart from the reference's other runs. */
function runMenuLabel(
  run: AgentRefRun,
  isLatest: boolean,
  t: (key: I18nKey, params?: I18nParams) => string,
  relativeTime: (iso: string) => string,
  latestText: string,
): string {
  const status = t(`subagent.status.${run.status}` as I18nKey);
  const when = run.startedAt === undefined ? undefined : relativeTime(run.startedAt);
  return [
    isLatest ? latestText : undefined,
    run.label,
    status,
    when,
  ].filter((part): part is string => part !== undefined && part !== '').join(' · ');
}

/**
 * The engine catalog when the surface has a connection, empty otherwise. The
 * chip renders inside read-only and test surfaces too, where there is no
 * connection to query — the engine then falls back to its raw id, matching
 * how the catalog reads while it is still loading.
 */
function useOptionalExecutorCatalog() {
  const connection = useOptionalConnection();
  const client = connection?.client;
  const scopeId = connection?.scopeId;
  const serverId = connection?.meta?.server_id;
  const query = useQuery({
    queryKey: executorCatalogQueryKey(scopeId ?? '', serverId),
    queryFn: () => client!.listExecutors(),
    enabled: client !== undefined && typeof client.listExecutors === 'function',
    staleTime: 60_000,
    retry: false,
  });
  return query.data?.items ?? [];
}

/** The quiet cue a rejected chip carries in words: the run never started. */
function RejectedBody({ reference, engine, statusText }: { readonly reference: AgentReference; readonly engine: string; readonly statusText: string }) {
  const { t } = useI18n();
  return (
    <>
      <span aria-hidden className="flex h-3 w-3 shrink-0 items-center justify-center">
        {statusDot('rejected')}
      </span>
      <Icon name="agent" size={12} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 truncate font-medium text-ink-faint line-through decoration-ink-faint/60">{reference.profile}</span>
      <span className="shrink-0 text-ink-faint">{engine}</span>
      <span className="shrink-0 text-[11px] text-danger/80">{t('agentRef.rejectedCue')}</span>
      <span className="sr-only">{statusText}</span>
    </>
  );
}

export function AgentRefChip({
  reference,
  delegation,
  onOpen,
}: {
  readonly reference: AgentReference;
  readonly delegation: AgentRefDelegation;
  /** Opens the delegated child run; absent means this surface cannot navigate. */
  readonly onOpen?: (agentId: string) => void;
}) {
  const { t, tp, time } = useI18n();
  const catalog = useOptionalExecutorCatalog();
  const [runMenu, setRunMenu] = useState<{ x: number; y: number } | null>(null);
  const statusText = t(`agentRef.status.${delegation.status}`);
  // The engine label, in the order a reader can trust it: the label the
  // producer persisted on the reference itself, then the catalog's label (the
  // badge the picker shows), then the raw engine id while neither has it. A
  // native target reads "native engine".
  const engine = reference.engine_label ?? catalogEngineLabel(reference.executor, t('agentRef.configuration.native'), catalog);
  const details = t('agentRef.details', { profile: reference.profile, executor: reference.executor, configuration: engine });

  if (delegation.status === 'rejected') {
    return (
      <span
        data-agent-ref-chip={reference.refId}
        data-agent-ref-status="rejected"
        title={[details, statusText].join('\n')}
        aria-label={`${t('agentRef.aria', { profile: reference.profile })} · ${statusText}`}
        className={INLINE_SHAPE}
      >
        <RejectedBody reference={reference} engine={engine} statusText={statusText} />
      </span>
    );
  }

  if (delegation.status === 'delegated' && onOpen !== undefined) {
    const runs = delegation.runs;
    const latest = runs[0]!;
    const runsText = tp('agentRef.runs', runs.length);
    const tooltip = runs.length > 1
      ? [details, runsText, ...runs.map((run, index) => runMenuLabel(run, index === 0, t, time.relativeTime, t('agentRef.runLatest')))].join('\n')
      : [details, statusText].join('\n');
    const body = (
      <>
        <span aria-hidden className="flex h-3 w-3 shrink-0 items-center justify-center">
          {statusDot('delegated')}
        </span>
        <Icon name="agent" size={12} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate font-medium text-ink">{reference.profile}</span>
        <span className="shrink-0 text-ink-faint">{engine}</span>
        {runs.length > 1 ? <span className="shrink-0 tabular-nums text-ink-faint">{runsText}</span> : null}
      </>
    );
    const openRun = (run: AgentRefRun) => { onOpen(run.agentId); };
    return (
      <>
        <button
          type="button"
          data-agent-ref-chip={reference.refId}
          data-agent-ref-status="delegated"
          data-agent-ref-agent={latest.agentId}
          data-agent-ref-runs={runs.length > 1 ? runs.length : undefined}
          title={tooltip}
          aria-label={`${t('agentRef.open', { profile: reference.profile })} · ${statusText}`}
          onClick={(event) => {
            event.stopPropagation();
            if (runs.length > 1) {
              setRunMenu({ x: event.clientX, y: event.clientY });
              return;
            }
            openRun(latest);
          }}
          className={`${INLINE_SHAPE} cursor-pointer no-underline transition-colors hover:bg-paper focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none`}
        >
          {body}
        </button>
        {runMenu === null ? null : (
          <MiniContextMenu
            x={runMenu.x}
            y={runMenu.y}
            ariaLabel={runsText}
            overlayId="agent-ref-runs-menu"
            dataAttribute="data-agent-ref-runs-menu"
            onClose={() => { setRunMenu(null); }}
            entries={runs.map((run, index) => ({
              key: run.taskId,
              label: runMenuLabel(run, index === 0, t, time.relativeTime, t('agentRef.runLatest')),
              run: () => { openRun(run); },
            }))}
          />
        )}
      </>
    );
  }

  return (
    <span
      data-agent-ref-chip={reference.refId}
      data-agent-ref-status={delegation.status}
      title={[details, statusText].join('\n')}
      aria-label={`${t('agentRef.aria', { profile: reference.profile })} · ${statusText}`}
      className={INLINE_SHAPE}
    >
      <span aria-hidden className="flex h-3 w-3 shrink-0 items-center justify-center">
        {statusDot('pending')}
      </span>
      <Icon name="agent" size={12} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 truncate font-medium text-ink">{reference.profile}</span>
      <span className="shrink-0 text-ink-faint">{engine}</span>
      <span className="sr-only">{statusText}</span>
    </span>
  );
}

/**
 * User-bubble projection: every `kiki://agents/<profile>` link in `text`
 * becomes a chip; the text between links goes through `projectSegment` (the
 * thread/room chips and the `@agent` chips). A text link joins the message
 * origin's structured reference by profile so the chip can name the ref the
 * task's `source_ref` carries; a link with no structured twin (a hand-typed
 * link the engine never resolved, or an older record) still renders, but as
 * "not delegated yet" — it has no ref to delegate.
 */
export function AgentRefText({
  text,
  references,
  messageId,
  projectSegment,
}: {
  readonly text: string;
  /** The message origin's structured references, keyed by profile. */
  readonly references: readonly AgentReference[];
  readonly messageId?: string;
  readonly projectSegment: (segment: string) => ReactNode;
}) {
  const resolution = useAgentRefResolution();
  const matches = useMemo(() => findAgentRefs(text), [text]);
  const byProfile = useMemo(() => {
    const map = new Map<string, AgentReference>();
    for (const reference of references) {
      if (!map.has(reference.profile)) map.set(reference.profile, reference);
    }
    return map;
  }, [references]);
  if (matches.length === 0) return <>{projectSegment(text)}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) parts.push(<span key={`a-${cursor}`}>{projectSegment(text.slice(cursor, match.start))}</span>);
    const reference = byProfile.get(match.profile) ?? {
      refId: `text:${match.start}`,
      profile: match.profile,
      executor: 'native',
      configuration: 'native' as const,
      label: match.profile,
    };
    const delegation = resolution === null
      ? { status: 'pending' as const }
      : agentRefDelegation(reference, resolution.tasks, messageId);
    parts.push(
      <AgentRefChip
        key={`a-${match.start}`}
        reference={reference}
        delegation={delegation}
        onOpen={resolution?.onOpenAgent}
      />,
    );
    cursor = match.end;
  }
  if (cursor < text.length) parts.push(<span key={`a-${cursor}`}>{projectSegment(text.slice(cursor))}</span>);
  return <>{parts}</>;
}
