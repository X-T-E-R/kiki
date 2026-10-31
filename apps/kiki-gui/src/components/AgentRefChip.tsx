/**
 * Agent reference chip — a `kiki://agents/<profile>` link inside a user
 * message, rendered the same way the thread and room chips are: one quiet
 * token in the prose, sized to the line it sits in. The profile and engine
 * are always readable; the delegation status decides the click:
 *
 *   - delegated: the chip opens the child run the reference produced (the
 *     task whose `source_ref` names the same ref);
 *   - pending / rejected: the reference is still just a mention or the run
 *     never started, so the chip shows the status instead of jumping
 *     somewhere wrong.
 *
 * The chip never invents a child: with no matching task it has no href, so a
 * click is a no-op read of the status, not a dead navigation.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { findAgentRefs } from '@kiki/protocol';
import type { Task } from '@kiki/protocol';
import type { AgentReference } from '@kiki/transcript';
import { agentRefDelegation, type AgentRefDelegation } from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { Icon } from './icons';

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
  const { t } = useI18n();
  const statusText = t(`agentRef.status.${delegation.status}`);
  const configuration = t(`agentRef.configuration.${reference.configuration}`);
  const details = t('agentRef.details', { profile: reference.profile, executor: reference.executor, configuration });
  const tooltip = [details, statusText].join('\n');
  const body = (
    <>
      <span aria-hidden className="flex h-3 w-3 shrink-0 items-center justify-center">
        {statusDot(delegation.status)}
      </span>
      <Icon name="agent" size={12} className="shrink-0 text-ink-faint" />
      <span className="min-w-0 truncate font-medium text-ink">{reference.profile}</span>
      <span className="shrink-0 text-ink-faint">{configuration}</span>
    </>
  );
  const ariaLabel = `${t('agentRef.aria', { profile: reference.profile })} · ${statusText}`;
  if (delegation.status === 'delegated' && onOpen !== undefined) {
    const agentId = delegation.agentId;
    return (
      <button
        type="button"
        data-agent-ref-chip={reference.refId}
        data-agent-ref-status="delegated"
        data-agent-ref-agent={agentId}
        title={tooltip}
        aria-label={`${t('agentRef.open', { profile: reference.profile })} · ${statusText}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(agentId);
        }}
        className={`${INLINE_SHAPE} cursor-pointer no-underline transition-colors hover:bg-paper focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none`}
      >
        {body}
      </button>
    );
  }
  return (
    <span
      data-agent-ref-chip={reference.refId}
      data-agent-ref-status={delegation.status}
      title={tooltip}
      aria-label={ariaLabel}
      className={INLINE_SHAPE}
    >
      {body}
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
