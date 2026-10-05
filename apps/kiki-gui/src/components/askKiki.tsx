/**
 * "Let Kiki do it" — the shared entry for handing a setup task to a
 * conversation instead of a form.
 *
 * The surfaces that get one (personas, agent profiles, hooks, MCP) all do the
 * same three things, so they share one implementation: create a session, park
 * an editable `/skill …` draft in its composer, and navigate there. The user
 * reads the line and presses send themselves.
 *
 * The draft is the whole mechanism. `writeDraft` keyed by the new session id
 * touches no other session's draft and nothing on /new, and SessionView reads
 * it on mount, so the composer arrives already holding the text. Because the
 * text starts with a completed `/token `, the composer chips it as a skill and
 * `classifySlashSubmission` resolves it to that skill on submit — the skill is
 * activated by the ordinary slash flow, not merely named in prose.
 *
 * Deliberately NOT used: the `/new` → `/s/:id` route-state hand-off
 * (`initialPrompt` / `initialSkill`). SessionView auto-sends that the moment
 * the snapshot loads, which would spend a model turn on a sentence the user
 * has not read yet.
 *
 * One create per activation: the returned `busy` latches synchronously with
 * the click and only clears once the create settles, so a double click cannot
 * leave a trail of empty sessions. A failed create releases the button and
 * says what failed in the user's terms plus the way out.
 *
 * Leaving is settled BEFORE anything is created. A hooks or MCP editor can hold
 * an unsaved draft, and its discard prompt is the one seat that decides whether
 * this page may go away — so the create runs inside the guard's action rather
 * than before it. Cancelling the prompt therefore leaves no session, no draft
 * and no stolen caret, which is what "cancel" has to mean on a destructive step.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { writeDraft } from '@kiki/session-core/composer';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { SessionCreate, Workspace } from '@kiki/protocol';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';

import { useI18n } from '../i18n';
import { pushToast } from '../lib/toasts';
import { useConnection } from '../state/connection';
import { useDirtyGuard, useGuardedNavigate } from './dirtyGuard';
import { SECONDARY_BUTTON } from './ui';

/**
 * The button itself. A quiet second-level action that sits next to the page's
 * real verb: same border and type scale as its neighbour, one short label, and
 * the full intent in the accessible name plus the native tooltip (so hovering
 * answers "what does this do" without adding a paragraph to the page). It
 * never competes with the primary action, and while its session is being made
 * it holds the same disabled state the primary actions use.
 */
export function AskKikiButton({ label, labelAria, busy, disabled = false, testId, onAsk }: {
  readonly label: string;
  /** The full intent for assistive tech and the hover title. */
  readonly labelAria: string;
  readonly busy: boolean;
  /** Also blocks the press while the session's location is still unknown. */
  readonly disabled?: boolean;
  readonly testId: string;
  readonly onAsk: () => void;
}) {
  return (
    <button
      type="button"
      {...{ [testId]: '' }}
      title={labelAria}
      aria-label={labelAria}
      disabled={busy || disabled}
      onClick={onAsk}
      className={`${SECONDARY_BUTTON} shrink-0 pointer-coarse:min-h-11`}
    >
      {label}
    </button>
  );
}

/**
 * A task worth handing over: the skill to activate, plus the sentence the user
 * would otherwise have typed into that skill's form. `promptKey` is written
 * into the composer verbatim and stays editable, so the user may rewrite the
 * target before sending.
 */
export interface AskKikiTask {
  readonly skill: string;
  readonly promptKey: I18nKey;
  /**
   * Where the work applies, as one plain trailing line. Non-sensitive
   * identifiers only: an env var, header or API-key form value is not an
   * identifier, and putting one into text a model will read is the one thing
   * this path must never do. A display name is not an address either — the
   * address travels in `location`, and the two must agree.
   */
  readonly context?: string;
  /**
   * The directory the new session must actually work in. A caller that knows
   * the exact place it edits (MCP's `cwd`, a profile's chosen workspace)
   * passes it here; everyone else leaves it undefined and inherits the same
   * default `/new` uses.
   */
  readonly location?: AskKikiLocation;
}

/**
 * Where the session runs. Exactly one form may be given: the server rejects a
 * `metadata.cwd` that disagrees with a `workspace_id`'s root, so sending a
 * mismatched pair would be worse than sending neither.
 */
export type AskKikiLocation =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'cwd'; readonly cwd: string };

/**
 * The create body for a location. `undefined` means "no address at all", which
 * the server answers with a fresh auto workspace — the same thing `/new` does
 * when this machine genuinely has no workspaces yet, and never a stand-in for
 * a location the caller knew and failed to pass.
 */
export function askKikiCreateBody(location: AskKikiLocation | undefined): SessionCreate {
  if (location === undefined) return {};
  return location.kind === 'cwd'
    ? { metadata: { cwd: location.cwd } }
    : { workspace_id: location.workspaceId };
}

export interface UseAskKiki {
  /** Open a session for `task`; resolves once the user has been sent there. */
  readonly ask: (task: AskKikiTask) => Promise<void>;
  readonly busy: boolean;
}

/** `/skill intent`, the shape the composer's slash flow already speaks. */
export function buildAskKikiPrompt(skill: string, intent: string, context?: string): string {
  const line = `/${skill} ${intent}`.trimEnd();
  return context === undefined || context.trim() === '' ? line : `${line}\n${context}`;
}

// The composer is the shell's resident node, and the new session's snapshot
// still has to load before it is mounted and enabled. A frame count cannot
// cover that (a slow server is seconds, not frames), so this polls on a real
// deadline and gives up quietly — focus is a convenience, never a blocker.
const FOCUS_DEADLINE_MS = 4000;
const FOCUS_POLL_MS = 80;

function focusComposerWhenReady(): void {
  const deadline = Date.now() + FOCUS_DEADLINE_MS;
  const attempt = () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-composer]');
    if (textarea !== null && !textarea.disabled) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      return;
    }
    if (Date.now() >= deadline) return;
    window.setTimeout(attempt, FOCUS_POLL_MS);
  };
  attempt();
}

export function useAskKiki(): UseAskKiki {
  const { client, scopeId } = useConnection();
  const { t, locale } = useI18n();
  const navigate = useGuardedNavigate();
  const guard = useDirtyGuard();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // Only the create + draft. The leave stays the guarded navigator's job, which
  // is why the guard runs this first and the navigation happens inside that
  // same action — after the confirmation has cleared the dirty set.
  const createAndDraft = useCallback(async (signal: AbortSignal, task: AskKikiTask, create: SessionCreate) => {
    const session = await client.createSession(create);
    signal.throwIfAborted();
    writeDraft(session.id, buildAskKikiPrompt(task.skill, t(task.promptKey), task.context));
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    // This create just confirmed the target in this connection scope, so the
    // route's own guard may admit the session without re-validating it.
    queryClient.setQueryData(['space-view-target', scopeId, 'session', session.id], true);
    return session.id;
  }, [client, queryClient, scopeId, t]);

  const ask = useCallback((task: AskKikiTask) => {
    if (inFlight.current) return Promise.resolve();
    inFlight.current = true;
    setBusy(true);
    // Cancelling the leave prompt must leave nothing behind: no session, no
    // draft, no stolen focus. So the create runs INSIDE the guarded action,
    // which the guard holds back until the user agrees to leave.
    const launch = async (signal: AbortSignal) => {
      const create = askKikiCreateBody(task.location);
      const sessionId = await createAndDraft(signal, task, create);
      navigate(`/s/${sessionId}`, { state: { createdSession: { id: sessionId, scopeId } } });
      focusComposerWhenReady();
    };
    const run = guard?.runAction !== undefined
      ? guard.runAction(launch)
      : Promise.resolve(launch(new AbortController().signal));
    return Promise.resolve(run)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        pushToast({ tone: 'error', text: t('askKiki.failed', { detail: errorText(locale, error) }) });
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  }, [createAndDraft, guard, locale, navigate, scopeId, t]);

  return { ask, busy };
}

/**
 * The workspace a handoff should run in when the caller has no address of its
 * own (personas, hooks, MCP without a `cwd`).
 *
 * This is `/new`'s own rule, read from the same source: the most recently used
 * workspace of this connection (`sortWorkspacesByRecency`), which is what the
 * user would have got by opening a new conversation here. A caller that knows
 * better — the profiles page, which is explicitly filtered to one workspace —
 * passes that workspace instead and this hook is not used.
 *
 * `undefined` is returned in exactly two cases, and they are deliberately the
 * two cases where "no address" is the honest answer: the list really is empty,
 * or the list is still loading or failed. The third state is never faked: a
 * failed list read is not an empty list, so it must not silently fall through
 * to a fresh auto-created directory as though the user had none.
 */
export function useAskKikiWorkspace(): {
  readonly location: AskKikiLocation | undefined;
  /** Whether the session may be created now (false while loading or on error). */
  readonly resolved: boolean;
} {
  const { client } = useConnection();
  const query = useQuery({ queryKey: ['workspaces'], queryFn: () => client.listWorkspaces(), staleTime: 30_000 });
  const workspaces = query.data?.items;
  const location = useMemo(
    () => (workspaces === undefined ? undefined : asWorkspaceLocation(sortWorkspacesByRecency(workspaces)[0])),
    [workspaces],
  );
  return { location, resolved: query.isSuccess };
}

/** A workspace the user can already see, addressed by id rather than by label. */
function asWorkspaceLocation(workspace: Workspace | undefined): AskKikiLocation | undefined {
  return workspace === undefined ? undefined : { kind: 'workspace', workspaceId: workspace.id };
}
