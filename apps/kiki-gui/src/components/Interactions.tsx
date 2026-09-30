/**
 * Approval strip — the inline decision element (one accent left rule, no tint). Hardened after aionui's
 * PermissionRequestPanel (https://github.com/AionUi/AionUi —
 * `packages/desktop/src/renderer/pages/conversation/Messages/components/
 * MessagePermission/PermissionRequestPanel.tsx` + `permissionOptions.ts`,
 * Apache-2.0), adapted to kiki's wire (decision + optional 'session' scope):
 *
 *   - options classify into intents: allow-once (accent solid), allow-always
 *     (the "remember for this session" scope), reject-once (outline). The
 *     wire has no reject-always; cancelled exists but is not user-facing here.
 *   - single-click submit with an in-flight double-click guard
 *     (respondingRef) and a stale-response epoch guard (a late-settling
 *     promise from a previous request instance never writes state);
 *   - after answering, the button row is replaced inline by the outcome
 *     status (and by the compact resolution line once the stream confirms);
 *   - when the request carries no displayable command, the detail block falls
 *     back to labeled raw JSON instead of a misleading pseudo-title.
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { QueryClientContext } from '@tanstack/react-query';

import type { ApprovalDecision, QuestionAnswer, QuestionItem } from '@kiki/protocol';

import type { ApprovalBlock, QuestionBlock } from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { PERMISSION_RULES_ROUTE, saveAllowRule } from '../lib/permissionRules';
import { pushToast } from '../lib/toasts';
import { useOptionalConnection } from '../state/connection';
import { reviewerLabel, reviewerTooltip } from './approvalReviewer';
import { DisclosureChevron, Icon } from './icons';
import { Markdown } from './Markdown';
import { SshApprovalCard } from './ssh/SshApprovalCard';

type ApprovalIntent = 'allow-once' | 'allow-always' | 'allow-rule' | 'reject-once';

/** What a plan review sends besides the decision (native ExitPlanMode and external `exit_plan_mode`). */
export interface PlanReviewResponse {
  readonly feedback?: string;
  /** `Revise` keeps planning with the note; `Reject and Exit` leaves plan mode. */
  readonly selectedLabel?: string;
}

interface PlanReviewDisplay {
  readonly plan: string;
  readonly path?: string;
  readonly options?: readonly { readonly label: string; readonly description: string }[];
}

/** The `plan_review` display, or undefined for any other approval. */
export function planReviewFromDisplay(display: unknown): PlanReviewDisplay | undefined {
  if (typeof display !== 'object' || display === null) return undefined;
  const record = display as Record<string, unknown>;
  if (record['kind'] !== 'plan_review' || typeof record['plan'] !== 'string') return undefined;
  const options = Array.isArray(record['options'])
    ? record['options'].filter((option): option is { label: string; description: string } =>
        typeof option === 'object' && option !== null && typeof (option as { label?: unknown }).label === 'string')
      .map((option) => ({ label: option.label, description: typeof option.description === 'string' ? option.description : '' }))
    : undefined;
  return { plan: record['plan'], path: typeof record['path'] === 'string' ? record['path'] : undefined, options };
}

/* Shared decision-strip styling for approvals and questions. The accent is
 * ONE left rule (the "needs you" mark) on a flat surface — no tint: the tray
 * around the strip is already the container, and a tinted card inside it was
 * a card inside a card. One flat detail well, a solid primary, a quiet
 * secondary. */
const STRIP_CLASS =
  'anim-enter border-l-2 border-accent py-2.5 pr-3 pl-3.5';
const DETAIL_WELL =
  'mt-2 max-h-40 overflow-auto rounded-md bg-ink/[0.04] px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-ink';
const PRIMARY_BUTTON =
  'inline-flex min-h-8 items-center rounded-md bg-accent px-3.5 text-[13px] font-semibold text-primary-foreground transition-colors duration-[var(--kiki-motion-quick)] hover:bg-accent-deep disabled:opacity-60';
const SECONDARY_BUTTON =
  'inline-flex min-h-8 items-center rounded-md px-3 text-[13px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.05] hover:text-ink disabled:opacity-60';

/* ── External permission display (ACP harness, design §9) ──────────────── */

/**
 * GUI-local mirror of the `external_permission` display shape. The option set
 * is OPEN: agents may emit kinds beyond the four common ones, and every option
 * the agent offered must be rendered — the exact option id is what round-trips
 * back in `selected_option_id`.
 */
export interface ExternalPermissionOption {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly changes?: readonly unknown[];
}

export interface ExternalPermissionDisplay {
  readonly kind: 'external_permission';
  readonly summary: string;
  readonly detail?: unknown;
  readonly options: readonly ExternalPermissionOption[];
}

export type ExternalPermissionParse =
  | { readonly ok: true; readonly display: ExternalPermissionDisplay }
  | { readonly ok: false };

/**
 * Undefined when the payload is some other display kind; `{ok:false}` when it
 * claims `external_permission` but fails validation — the card must then fail
 * closed (cancel only), never default-approve.
 */
export function externalPermissionFromDisplay(display: unknown): ExternalPermissionParse | undefined {
  if (typeof display !== 'object' || display === null) return undefined;
  const record = display as Record<string, unknown>;
  if (record['kind'] !== 'external_permission') return undefined;
  const summary = record['summary'];
  const rawOptions = record['options'];
  if (typeof summary !== 'string' || summary === '' || !Array.isArray(rawOptions)) {
    return { ok: false };
  }
  const options: ExternalPermissionOption[] = [];
  for (const raw of rawOptions) {
    if (typeof raw !== 'object' || raw === null) return { ok: false };
    const option = raw as Record<string, unknown>;
    const id = option['id'];
    const label = option['label'];
    const kind = option['kind'];
    if (typeof id !== 'string' || id === '') return { ok: false };
    if (typeof label !== 'string' || label === '') return { ok: false };
    if (typeof kind !== 'string' || kind === '') return { ok: false };
    const changes = option['changes'];
    if (changes !== undefined && !Array.isArray(changes)) return { ok: false };
    options.push({ id, label, kind, changes: changes as readonly unknown[] | undefined });
  }
  if (options.length === 0) return { ok: false };
  return {
    ok: true,
    display: { kind: 'external_permission', summary, detail: record['detail'], options },
  };
}

/** Reject-ish option kinds map to a rejected decision; everything else the
 * agent offered is an explicit user pick recorded as approved — the adapter
 * re-validates the exact id against the original request either way. */
function decisionForExternalKind(kind: string): ApprovalDecision {
  return kind.toLowerCase().includes('reject') ? 'rejected' : 'approved';
}

function externalKindLabel(kind: string, t: Translate): string {
  switch (kind) {
    case 'allow_once':
      return t('ia.external.kind.allowOnce');
    case 'allow_always':
      return t('ia.external.kind.allowAlways');
    case 'reject_once':
      return t('ia.external.kind.rejectOnce');
    case 'reject_always':
      return t('ia.external.kind.rejectAlways');
    default:
      return kind;
  }
}

function boundedJson(value: unknown, limit = 400): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? '';
    return json.length > limit ? `${json.slice(0, limit)}…` : json;
  } catch {
    return String(value);
  }
}

function intentFor(decision: ApprovalDecision, scope: 'session' | undefined): ApprovalIntent {
  if (decision === 'approved') return scope === 'session' ? 'allow-always' : 'allow-once';
  return 'reject-once';
}

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * The displayable detail for a request. Returns `{ label, text }`; when the
 * display payload has no recognizable command/path/summary, falls back to a
 * labeled raw-JSON dump (aionui's honest-degradation rule) rather than
 * inventing a title. Undefined when there is genuinely nothing to show.
 */
function approvalDetail(
  block: ApprovalBlock,
  t: Translate,
): { label: string; text: string } | undefined {
  const display = block.request.tool_input_display;
  if (typeof display !== 'object' || display === null) return undefined;
  const kind = (display as { kind?: unknown }).kind;
  // plan_enter carries no payload fields — the card body renders the copy.
  if (kind === 'plan_enter') return undefined;
  if (kind === 'command') {
    const command = (display as { command?: string }).command;
    return command !== undefined && command !== ''
      ? { label: t('ia.detail.command'), text: command }
      : undefined;
  }
  if (kind === 'file_io') {
    const d = display as { operation?: string; path?: string };
    const text = `${d.operation ?? ''} ${d.path ?? ''}`.trim();
    return text !== '' ? { label: t('ia.detail.file'), text } : undefined;
  }
  if (kind === 'diff') {
    const path = (display as { path?: string }).path;
    return path !== undefined ? { label: t('ia.detail.file'), text: path } : undefined;
  }
  if (kind === 'url_fetch') {
    const url = (display as { url?: string }).url;
    return url !== undefined ? { label: t('ia.detail.url'), text: url } : undefined;
  }
  if (kind === 'search') {
    const d = display as { query?: string; scope?: string };
    const text = d.scope !== undefined ? `${d.query ?? ''} — ${d.scope}` : d.query;
    return text !== undefined && text !== '' ? { label: t('ia.detail.search'), text } : undefined;
  }
  if (kind === 'agent_call') {
    const d = display as { agent_name?: string; prompt?: string };
    const text = `${d.agent_name ?? ''}${d.prompt !== undefined ? ` — ${d.prompt}` : ''}`.trim();
    return text !== '' ? { label: t('ia.detail.subagent'), text } : undefined;
  }
  if (kind === 'skill_call') {
    const d = display as { skill_name?: string; args?: string };
    const text = `${d.skill_name ?? ''}${d.args !== undefined ? ` ${d.args}` : ''}`.trim();
    return text !== '' ? { label: t('ia.detail.skill'), text } : undefined;
  }
  if (kind === 'generic') {
    const summary = (display as { summary?: string }).summary;
    return summary !== undefined && summary !== ''
      ? { label: t('ia.detail.details'), text: summary }
      : undefined;
  }
  try {
    const json = JSON.stringify(display, null, 2);
    if (json === undefined || json === '{}') return undefined;
    return { label: t('ia.detail.details'), text: json.length > 800 ? `${json.slice(0, 800)}…` : json };
  } catch {
    return undefined;
  }
}

const NEAR_DEADLINE_MS = 10 * 60_000;

/** True when the request expires within ten minutes (and has a real deadline). */
export function deadlineIsNear(expiresAt: string, now: number = Date.now()): boolean {
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return false;
  const left = at - now;
  return left > 0 && left < NEAR_DEADLINE_MS;
}

export function ApprovalCard({
  block,
  onResolve,
  originAgentName,
  showShortcutHints = false,
}: {
  block: ApprovalBlock;
  onResolve: (decision: ApprovalDecision, scope?: 'session', selectedOptionId?: string, review?: PlanReviewResponse) => Promise<void>;
  /** Display name of the subagent that issued the request, when not main. */
  originAgentName?: string;
  /** y/n hints show on every pending card (focused or topmost visible wins). */
  showShortcutHints?: boolean;
}) {
  const { t, time } = useI18n();
  const connection = useOptionalConnection();
  const queryClient = useContext(QueryClientContext);
  const navigate = useNavigate();
  const [forSession, setForSession] = useState(false);
  // "Always allow": the rule the server saved for this card, or a failed write.
  const [savedRule, setSavedRule] = useState<string | null>(null);
  const [ruleFailed, setRuleFailed] = useState(false);
  const [submitting, setSubmitting] = useState<ApprovalIntent | null>(null);
  const [submittingOptionId, setSubmittingOptionId] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ApprovalDecision | null>(null);
  const [failed, setFailed] = useState(false);
  const respondingRef = useRef(false);
  // Epoch guard: bumped whenever this card's request identity changes; async
  // completions compare against their captured epoch before touching state.
  const epochRef = useRef(0);
  const approvalId = block.request.approval_id;
  useEffect(() => {
    epochRef.current += 1;
    respondingRef.current = false;
    setSubmitting(null);
    setSubmittingOptionId(null);
    setAnswered(null);
    setFailed(false);
    setSavedRule(null);
    setRuleFailed(false);
  }, [approvalId]);
  useEffect(
    () => () => {
      epochRef.current += 1; // unmount: late completions become no-ops
    },
    [],
  );

  if (block.resolution !== undefined) {
    const { decision, reviewer } = block.resolution;
    const label =
      decision === 'approved'
        ? t('ia.resolution.approved')
        : decision === 'rejected'
          ? t('ia.resolution.rejected')
          : decision === 'cancelled'
            ? t('ia.resolution.cancelled')
            : decision === 'expired'
              ? t('ia.resolution.expired')
              : t('ia.resolution.resolvedElsewhere');
    // Same outcome rule as every timeline row: an approval that went through
    // is a plain fact with no mark; only a refusal is marked and tinted.
    const tone =
      decision === 'approved' || decision === 'resolved_elsewhere'
        ? 'text-ink-soft'
        : 'text-danger';
    return (
      <div
        data-approval-resolution={decision}
        className={`anim-enter flex min-h-7 items-center gap-2 text-[13px] ${tone}`}
      >
        {decision === 'approved' || decision === 'resolved_elsewhere' ? null : <Icon name="cross" />}
        <span className="font-medium" title={reviewer === undefined ? undefined : reviewerTooltip(reviewer, t)}>
          {reviewer === undefined ? label : reviewerLabel(decision, reviewer, t, label)}
        </span>
        <span className="truncate font-mono text-[12px] text-ink-faint">
          {block.request.tool_name} — {block.request.action}
        </span>
      </div>
    );
  }

  // SSH login / host-key requests answer through their own route (ssh/SshApprovalCard).
  if (block.request.ssh !== undefined) {
    return <SshApprovalCard block={block} ssh={block.request.ssh} originAgentName={originAgentName} />;
  }

  const planReview = planReviewFromDisplay(block.request.tool_input_display);
  if (planReview !== undefined) {
    return <PlanReviewCard key={approvalId} block={block} plan={planReview} originAgentName={originAgentName}
      showShortcutHints={showShortcutHints} onResolve={onResolve} />;
  }

  const external = externalPermissionFromDisplay(block.request.tool_input_display);
  const planEnter =
    external === undefined &&
    typeof block.request.tool_input_display === 'object' &&
    block.request.tool_input_display !== null &&
    (block.request.tool_input_display as { kind?: unknown }).kind === 'plan_enter';
  const detail = external === undefined ? approvalDetail(block, t) : undefined;

  const submit = (decision: ApprovalDecision, selectedOptionId?: string) => {
    // In-flight guard: drop double-clicks and clicks during submission.
    if (respondingRef.current || answered !== null) return;
    const scope = forSession ? ('session' as const) : undefined;
    const intent = intentFor(decision, scope);
    const epoch = epochRef.current;
    respondingRef.current = true;
    setSubmitting(intent);
    setSubmittingOptionId(selectedOptionId ?? (decision === 'cancelled' ? '__cancel' : null));
    setFailed(false);
    void onResolve(decision, scope, selectedOptionId)
      .then(() => {
        if (epochRef.current !== epoch) return; // stale response — newer request owns the card
        setAnswered(decision);
      })
      .catch(() => {
        if (epochRef.current !== epoch) return;
        setFailed(true);
      })
      .finally(() => {
        if (epochRef.current !== epoch) return;
        respondingRef.current = false;
        setSubmitting(null);
        setSubmittingOptionId(null);
      });
  };

  // "Always allow": save the exact-call rule the engine offered as a
  // persistent allow rule first, then approve this one call. A failed write
  // approves nothing, so the user never gets a rule they did not see saved.
  const approvalRule = external === undefined && !planEnter && connection !== null
    ? block.request.approval_rule
    : undefined;
  const allowAlways = () => {
    if (approvalRule === undefined || connection === null) return;
    if (respondingRef.current || answered !== null) return;
    const epoch = epochRef.current;
    respondingRef.current = true;
    setSubmitting('allow-rule');
    setFailed(false);
    setRuleFailed(false);
    void saveAllowRule(connection.client, approvalRule)
      .then((config) => {
        queryClient?.setQueryData(['config'], config);
        if (epochRef.current !== epoch) return;
        setSavedRule(approvalRule);
        pushToast({
          tone: 'success',
          text: t('ia.alwaysAllow.saved', { rule: approvalRule }),
          retry: { label: t('ia.alwaysAllow.manage'), run: () => { void navigate(PERMISSION_RULES_ROUTE); } },
        });
        return onResolve('approved').then(() => {
          if (epochRef.current === epoch) setAnswered('approved');
        }, () => {
          if (epochRef.current === epoch) setFailed(true);
        });
      }, () => {
        if (epochRef.current === epoch) setRuleFailed(true);
      })
      .finally(() => {
        if (epochRef.current !== epoch) return;
        respondingRef.current = false;
        setSubmitting(null);
      });
  };

  const cancelButton = (
    <button
      type="button"
      disabled={submittingOptionId !== null}
      onClick={() => { submit('cancelled'); }}
      className={SECONDARY_BUTTON}
    >
      {submittingOptionId === '__cancel' ? t('ia.external.cancelling') : t('ia.external.cancel')}
    </button>
  );
  const sendFailed = failed ? (
    <p role="alert" className="mt-2 text-[12px] text-danger">
      {t('ia.sendFailed')}
    </p>
  ) : null;

  return (
    <div
      data-approval-id={approvalId}
      className={STRIP_CLASS}
    >
      {/* Provenance line: what kind of decision, who asked, time left. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
        <span className="font-medium text-accent-ink">
          {external === undefined
            ? planEnter
              ? t('ia.planEnter.title')
              : t('ia.approvalNeeded')
            : t('ia.external.title')}
        </span>
        {external !== undefined ? (
          <span className="text-ink-faint">· {t('ia.external.badge')}</span>
        ) : null}
        {originAgentName !== undefined ? (
          <span className="text-ink-faint">· {t('ia.fromSubagent', { name: originAgentName })}</span>
        ) : null}
        {/* A far-off deadline is noise; it only matters once it is close. */}
        {deadlineIsNear(block.request.expires_at) ? (
          <span className="ml-auto text-ink-faint tabular-nums">
            {time.timeUntil(block.request.expires_at)}
          </span>
        ) : null}
      </div>
      {/* What: tool + action, then the exact command/target. */}
      <p className="mt-1 min-w-0 text-[14px] leading-snug text-ink">
        <span className="font-mono text-[13px] font-semibold">{block.request.tool_name}</span>
        <span className="text-ink-soft"> · {block.request.action}</span>
      </p>
      {planEnter ? (
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
          {t('ia.planEnter.body')}
        </p>
      ) : null}
      {detail !== undefined ? (
        <pre
          aria-label={detail.label}
          title={detail.label}
          className={DETAIL_WELL}
        >
          {detail.label === t('ia.detail.command') ? (
            <span className="text-ink-faint select-none">$ </span>
          ) : null}
          {detail.text}
        </pre>
      ) : null}

      {external?.ok === true ? (
        <div className="mt-1.5">
          <p className="text-[13px] text-ink">{external.display.summary}</p>
          {external.display.detail !== undefined ? (
            <pre className={DETAIL_WELL}>
              {typeof external.display.detail === 'string'
                ? external.display.detail
                : boundedJson(external.display.detail)}
            </pre>
          ) : null}
        </div>
      ) : null}

      {answered === null ? (
        external === undefined ? (
          <>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2" aria-busy={submitting !== null}>
              <button
                type="button"
                disabled={submitting !== null}
                onClick={() => { submit('approved'); }}
                className={PRIMARY_BUTTON}
              >
                {submitting === 'allow-once' || submitting === 'allow-always'
                  ? t('ia.approving')
                  : t('ia.approve')}{' '}
                {showShortcutHints ? (
                  <kbd className="ml-1 rounded-[4px] bg-primary-foreground/20 px-1 font-mono text-[11px] font-medium">y</kbd>
                ) : null}
              </button>
              {approvalRule !== undefined ? (
                <button
                  type="button"
                  data-approval-always-allow
                  disabled={submitting !== null}
                  onClick={allowAlways}
                  title={t('ia.alwaysAllow.title', { rule: approvalRule })}
                  className={SECONDARY_BUTTON}
                >
                  {submitting === 'allow-rule'
                    ? savedRule === null ? t('ia.alwaysAllow.saving') : t('ia.approving')
                    : t('ia.alwaysAllow')}
                </button>
              ) : null}
              <button
                type="button"
                disabled={submitting !== null}
                onClick={() => { submit('rejected'); }}
                className={SECONDARY_BUTTON}
              >
                {submitting === 'reject-once' ? t('ia.rejecting') : t('ia.reject')}{' '}
                {showShortcutHints ? (
                  <kbd className="ml-1 rounded-[4px] bg-ink/[0.07] px-1 font-mono text-[11px] text-ink-soft">n</kbd>
                ) : null}
              </button>
              <label className="ml-1 flex min-h-8 cursor-pointer items-center gap-1.5 text-[12px] text-ink-soft">
                <input
                  type="checkbox"
                  checked={forSession}
                  disabled={submitting !== null}
                  onChange={(event) => { setForSession(event.target.checked); }}
                  className="h-3.5 w-3.5 accent-[var(--color-selected-ink)]"
                />
                {t('ia.remember', { tool: block.request.tool_name })}
              </label>
            </div>
            {ruleFailed ? (
              <p role="alert" className="mt-2 text-[12px] text-danger">
                {t('ia.alwaysAllow.failed')}
              </p>
            ) : null}
            {savedRule !== null ? <SavedRuleNote rule={savedRule} /> : null}
            {sendFailed}
          </>
        ) : external.ok ? (
          <>
            <div
              className="mt-2.5 space-y-1"
              role="radiogroup"
              aria-busy={submittingOptionId !== null}
            >
              {external.display.options.map((option) => (
                <ExternalOptionButton
                  key={option.id}
                  option={option}
                  busy={submittingOptionId !== null}
                  submitting={submittingOptionId === option.id}
                  onPick={() => { submit(decisionForExternalKind(option.kind), option.id); }}
                />
              ))}
            </div>
            <div className="mt-2">{cancelButton}</div>
            {sendFailed}
          </>
        ) : (
          /* Fail closed: the payload claims external_permission but does not
             validate — no option may be picked, cancel stays available. */
          <>
            <p role="alert" className="mt-2 text-[13px] text-danger">
              {t('ia.external.unknownShape')}
            </p>
            <div className="mt-2">{cancelButton}</div>
            {sendFailed}
          </>
        )
      ) : (
        <p
          role="status"
          className={`mt-2.5 flex items-center gap-1.5 text-[13px] font-medium ${
            answered === 'approved' || answered === 'cancelled' ? 'text-ink-soft' : 'text-danger'
          }`}
        >
          {answered === 'approved' || answered === 'cancelled' ? null : <Icon name="cross" />}
          {answered === 'approved'
            ? t('ia.resolution.approved')
            : answered === 'cancelled'
              ? t('ia.resolution.cancelled')
              : t('ia.resolution.rejected')}
          {t('ia.sentToKikiSuffix')}
        </p>
      )}
      {answered !== null && savedRule !== null ? <SavedRuleNote rule={savedRule} /> : null}
    </div>
  );
}

/**
 * Plan review — the same strip as any approval, shaped for a plan: the plan
 * reads as Markdown in a bounded well, alternatives (when the agent offered
 * them) are a pick-one list, and the note travels with Revise. Serves native
 * ExitPlanMode and an external engine's `exit_plan_mode` alike: both resolve
 * through the one approval route with `feedback` + `selected_label`.
 */
function PlanReviewCard({
  block,
  plan,
  originAgentName,
  showShortcutHints,
  onResolve,
}: {
  block: ApprovalBlock;
  plan: PlanReviewDisplay;
  originAgentName?: string;
  showShortcutHints: boolean;
  onResolve: (decision: ApprovalDecision, scope?: 'session', selectedOptionId?: string, review?: PlanReviewResponse) => Promise<void>;
}) {
  const { t, time } = useI18n();
  const options = plan.options !== undefined && plan.options.length >= 2 ? plan.options : undefined;
  const [choice, setChoice] = useState<string | undefined>(options?.[0]?.label);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState<'approve' | 'revise' | 'exit' | null>(null);
  const [answered, setAnswered] = useState<'approve' | 'revise' | 'exit' | null>(null);
  const [failed, setFailed] = useState(false);
  const noteId = `plan-note-${block.request.approval_id}`;
  const trimmed = note.trim();

  const send = (action: 'approve' | 'revise' | 'exit') => {
    if (sending !== null || answered !== null) return;
    setSending(action);
    setFailed(false);
    const review: PlanReviewResponse = action === 'approve'
      ? { selectedLabel: choice }
      : { selectedLabel: action === 'revise' ? 'Revise' : 'Reject and Exit', ...(trimmed === '' ? {} : { feedback: trimmed }) };
    void onResolve(action === 'approve' ? 'approved' : 'rejected', undefined, undefined, review)
      .then(() => { setAnswered(action); }, () => { setFailed(true); })
      .finally(() => { setSending(null); });
  };

  return (
    <div data-approval-id={block.request.approval_id} data-plan-review className={STRIP_CLASS}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
        <span className="font-medium text-accent-ink">{t('ia.plan.title')}</span>
        {originAgentName !== undefined ? <span className="text-ink-faint">· {t('ia.fromSubagent', { name: originAgentName })}</span> : null}
        {plan.path !== undefined ? <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-faint" title={plan.path}>· {plan.path}</span> : null}
        {deadlineIsNear(block.request.expires_at) ? (
          <span className="ml-auto text-ink-faint tabular-nums">{time.timeUntil(block.request.expires_at)}</span>
        ) : null}
      </div>
      <div data-plan-body tabIndex={0} aria-label={t('ia.plan.bodyLabel')}
        className="mt-2 max-h-64 overflow-y-auto rounded-md bg-ink/[0.03] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40">
        <Markdown text={plan.plan} mode="static" />
      </div>
      {answered === null ? (
        <>
          {options !== undefined ? (
            <fieldset className="mt-2.5 space-y-1" disabled={sending !== null}>
              <legend className="mb-1 text-[12px] font-medium text-ink-soft">{t('ia.plan.choose')}</legend>
              {options.map((option) => (
                <label key={option.label} data-plan-option={option.label}
                  className={`flex min-h-9 cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-1.5 transition-colors ${choice === option.label ? 'bg-selected-ink/[0.07]' : 'hover:bg-ink/[0.04]'}`}>
                  <input type="radio" name={`plan-choice-${block.request.approval_id}`} checked={choice === option.label}
                    onChange={() => { setChoice(option.label); }} className="mt-1 h-3.5 w-3.5 accent-[var(--color-selected-ink)]" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{option.label}</span>
                    {option.description !== '' ? <span className="block text-[12px] leading-snug text-ink-soft">{option.description}</span> : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <label htmlFor={noteId} className="mt-2.5 block text-[12px] font-medium text-ink-soft">{t('ia.plan.note')}</label>
          <textarea id={noteId} data-plan-note rows={2} value={note} disabled={sending !== null}
            onChange={(event) => { setNote(event.target.value); }} placeholder={t('ia.plan.notePlaceholder')}
            className="mt-1 w-full resize-y rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[13px] leading-snug text-ink outline-none placeholder:text-ink-faint focus:border-selected-ink disabled:opacity-60" />
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-2" aria-busy={sending !== null}>
            <button type="button" data-plan-approve disabled={sending !== null} onClick={() => { send('approve'); }} className={PRIMARY_BUTTON}>
              {sending === 'approve' ? t('ia.approving') : options !== undefined && choice !== undefined ? t('ia.plan.approveChoice', { option: choice }) : t('ia.plan.approve')}
              {showShortcutHints ? <kbd className="ml-1.5 rounded-[4px] bg-primary-foreground/20 px-1 font-mono text-[11px] font-medium">y</kbd> : null}
            </button>
            <button type="button" data-plan-revise disabled={sending !== null || trimmed === ''} title={trimmed === '' ? t('ia.plan.reviseNeedsNote') : undefined}
              onClick={() => { send('revise'); }} className={SECONDARY_BUTTON}>
              {sending === 'revise' ? t('ia.sending') : t('ia.plan.revise')}
            </button>
            <button type="button" data-plan-exit disabled={sending !== null} onClick={() => { send('exit'); }}
              className={`${SECONDARY_BUTTON} hover:text-danger`}>
              {sending === 'exit' ? t('ia.rejecting') : t('ia.plan.rejectExit')}
            </button>
          </div>
          {failed ? <p role="alert" className="mt-2 text-[12px] text-danger">{t('ia.sendFailed')}</p> : null}
        </>
      ) : (
        <p role="status" data-plan-answered={answered}
          className={`mt-2.5 flex items-center gap-1.5 text-[13px] font-medium ${answered === 'exit' ? 'text-danger' : 'text-ink-soft'}`}>
          {answered === 'exit' ? <Icon name="cross" /> : null}
          {t(answered === 'approve' ? 'ia.plan.sentApproved' : answered === 'revise' ? 'ia.plan.sentRevise' : 'ia.plan.sentExit')}
        </p>
      )}
    </div>
  );
}

/** What "always allow" saved and where it can be removed again. */
function SavedRuleNote({ rule }: { rule: string }) {
  const { t } = useI18n();
  return (
    <p data-approval-rule-saved className="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] text-ink-soft">
      <span>{t('ia.alwaysAllow.savedShort')}</span>
      <code className="min-w-0 truncate font-mono text-[11.5px] text-ink">{rule}</code>
      <span aria-hidden className="text-ink-faint">·</span>
      <Link
        to={PERMISSION_RULES_ROUTE}
        className="rounded-sm text-accent-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-selected-ink"
      >
        {t('ia.alwaysAllow.undoHint')}
      </Link>
    </p>
  );
}

/**
 * One external permission option: semantic kind marker + agent-supplied label
 * + kind chip, with an expandable "what this grants" block for
 * `_meta.permission.changes[]`. Single click submits the exact option id.
 */
function ExternalOptionButton({
  option,
  busy,
  submitting,
  onPick,
}: {
  option: ExternalPermissionOption;
  busy: boolean;
  submitting: boolean;
  onPick: () => void;
}) {
  const { t, tp } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const lowered = option.kind.toLowerCase();
  const tone = lowered.startsWith('allow')
    ? { icon: 'check' as const, marker: 'text-success', chip: 'text-success' }
    : lowered.startsWith('reject')
      ? { icon: 'cross' as const, marker: 'text-danger', chip: 'text-danger' }
      : { icon: 'dash' as const, marker: 'text-ink-faint', chip: 'text-ink-faint' };
  const changes = option.changes ?? [];
  const kindLabel = externalKindLabel(option.kind, t);
  return (
    <div
      className={`rounded-md transition-colors duration-[var(--kiki-motion-quick)] ${
        submitting ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'
      }`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={submitting}
        disabled={busy}
        onClick={onPick}
        className="flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left disabled:opacity-60"
      >
        <Icon name={tone.icon} className={`h-3.5 w-3.5 ${tone.marker}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-ink">
            {submitting ? t('ia.sending') : option.label}
          </span>
        </span>
        {/* The kind reads as a quiet tag; skip it when the agent's own label
            already says the same thing. */}
        {kindLabel.toLowerCase() === option.label.toLowerCase() ? null : (
          <span className={`shrink-0 text-[12px] ${tone.chip}`}>{kindLabel}</span>
        )}
      </button>
      {changes.length > 0 ? (
        <div className="px-3 pb-1.5 pl-[34px]">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => { setExpanded((prev) => !prev); }}
            className="inline-flex min-h-6 items-center gap-1 text-[12px] font-medium text-ink-faint transition-colors hover:text-ink"
          >
            {tp('ia.external.changes', changes.length)}
            <DisclosureChevron open={expanded} />
          </button>
          {expanded ? (
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-paper px-2.5 py-1.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-soft">
              {changes.map((change) => boundedJson(change, 300)).join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Question card (AskUserQuestion) — every item behaves as a multi-select
 * (single-choice questions simply submit one checked option), and the "Other"
 * free-text input is always present: zero options plus a note is a valid
 * answer, and options can be combined with a note.
 */

export interface QuestionItemAnswer {
  optionIds: string[];
  otherText: string;
}

function QuestionItemView({
  item,
  answer,
  onChange,
}: {
  item: QuestionItem;
  answer: QuestionItemAnswer;
  onChange: (next: QuestionItemAnswer) => void;
}) {
  const { t } = useI18n();
  const toggle = (optionId: string) => {
    const optionIds = answer.optionIds.includes(optionId)
      ? answer.optionIds.filter((id) => id !== optionId)
      : [...answer.optionIds, optionId];
    onChange({ ...answer, optionIds });
  };
  const otherLabel = item.other_label ?? t('ia.other');
  return (
    <div>
      {item.header !== undefined ? (
        <p className="text-[12px] font-medium text-ink-faint">{item.header}</p>
      ) : null}
      <p className="mt-0.5 text-[14px] font-medium text-ink">{item.question}</p>
      {item.body !== undefined ? (
        <div className="mt-1 text-[13px] text-ink-soft">
          <Markdown text={item.body} />
        </div>
      ) : null}
      <div className="mt-2 space-y-0.5">
        {item.options.map((option) => {
          const selected = answer.optionIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              onClick={() => { toggle(option.id); }}
              className={`flex min-h-9 w-full items-start gap-2.5 rounded-md px-3 py-1.5 text-left transition-colors duration-[var(--kiki-motion-quick)] ${
                selected ? 'bg-paper shadow-[var(--kiki-sheet-shadow)]' : 'hover:bg-ink/[0.04]'
              }`}
            >
              <span
                aria-hidden
                className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${
                  selected ? 'border-ink bg-ink text-paper' : 'border-hairline-strong bg-paper'
                }`}
              >
                {selected ? <Icon name="check" size={12} /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink">{option.label}</span>
                {option.description !== undefined ? (
                  <span className="block text-[12px] text-ink-soft">{option.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}
        <label className="flex items-center gap-2.5 rounded-md px-3 pt-1.5">
          <span className="shrink-0 text-[13px] font-medium text-ink-soft">{otherLabel}</span>
          <input
            aria-label={otherLabel}
            className="min-h-8 w-full min-w-0 rounded-md border border-hairline bg-panel px-2.5 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            placeholder={item.other_description ?? t('ia.otherPlaceholder')}
            value={answer.otherText}
            onChange={(event) => { onChange({ ...answer, otherText: event.target.value }); }}
          />
        </label>
      </div>
    </div>
  );
}

export function QuestionCard({
  block,
  onAnswer,
  onDismiss,
  originAgentName,
}: {
  block: QuestionBlock;
  onAnswer: (answers: Record<string, QuestionAnswer>) => Promise<void>;
  onDismiss: () => Promise<void>;
  /** Display name of the subagent that asked, when not main. */
  originAgentName?: string;
}) {
  const { t, tp } = useI18n();
  const [selections, setSelections] = useState<Record<string, QuestionItemAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<null | 'answered' | 'dismissed'>(null);

  if (block.outcome !== undefined) {
    const label =
      block.outcome.kind === 'answered'
        ? t('ia.question.answered')
        : block.outcome.kind === 'dismissed'
          ? t('ia.question.dismissed')
          : t('ia.question.expired');
    return (
      <details className="anim-enter text-[12px] text-ink-faint" data-question-history>
        <summary className="min-h-7 cursor-pointer font-medium">{label}</summary>
        <div className="mt-2 space-y-2 text-ink-soft">
          {block.request.questions.map((item) => <div key={item.id}>
            <p className="break-words">{item.question}</p>
            <ul className="mt-1 list-inside list-disc text-[12px]">
              {item.options.map((option) => <li key={option.id}>{option.label}</li>)}
            </ul>
          </div>)}
        </div>
      </details>
    );
  }

  const answerFor = (id: string): QuestionItemAnswer =>
    selections[id] ?? { optionIds: [] as string[], otherText: '' };

  // An item counts as answered when at least one option is checked OR the
  // always-present Other input carries text — zero options plus a note is a
  // valid answer.
  const isItemAnswered = (item: (typeof block.request.questions)[number]): boolean => {
    const selection = answerFor(item.id);
    return selection.optionIds.length > 0 || selection.otherText.trim() !== '';
  };
  // Gate submit: unanswered sub-questions would be silently dropped from the
  // payload (and the server rejects partial answers with 40001 anyway).
  const unansweredCount = block.request.questions.filter((item) => !isItemAnswered(item)).length;

  const submit = () => {
    if (unansweredCount > 0) return;
    const answers: Record<string, QuestionAnswer> = {};
    for (const item of block.request.questions) {
      const selection = answerFor(item.id);
      const optionIds = selection.optionIds;
      const other = selection.otherText.trim();
      if (optionIds.length > 0 && other !== '') {
        answers[item.id] = {
          kind: 'multi_with_other',
          option_ids: optionIds,
          other_text: other,
        };
      } else if (other !== '') {
        answers[item.id] = { kind: 'other', text: other };
      } else if (optionIds.length === 1) {
        answers[item.id] = { kind: 'single', option_id: optionIds[0]! };
      } else if (optionIds.length > 1) {
        answers[item.id] = { kind: 'multi', option_ids: optionIds };
      }
    }
    if (Object.keys(answers).length === 0) return;
    setBusy(true);
    setFailed(null);
    onAnswer(answers)
      .then(() => { setSent('answered'); })
      .catch((error: unknown) => {
        setBusy(false);
        setFailed(
          error instanceof Error
            ? t('ia.answerFailed', { detail: error.message })
            : t('ia.answerFailedGeneric'),
        );
      });
  };

  const dismiss = () => {
    setBusy(true);
    setFailed(null);
    onDismiss()
      .then(() => { setSent('dismissed'); })
      .catch((error: unknown) => {
        setBusy(false);
        setFailed(
          error instanceof Error
            ? t('ia.dismissFailed', { detail: error.message })
            : t('ia.dismissFailedGeneric'),
        );
      });
  };

  return (
    <div data-question-card className={STRIP_CLASS}>
      <div className="space-y-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className="font-medium text-accent-ink">{t('ia.kikiAsks')}</span>
            {originAgentName !== undefined ? (
              <span className="text-ink-faint">· {t('ia.fromSubagent', { name: originAgentName })}</span>
            ) : null}
          </div>
        </div>
          {block.request.questions.map((item) => (
            <QuestionItemView
              key={item.id}
              item={item}
              answer={answerFor(item.id)}
              onChange={(next) => { setSelections((prev) => ({ ...prev, [item.id]: next })); }}
            />
          ))}
          {sent === null ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={busy || unansweredCount > 0}
                title={
                  unansweredCount > 0
                    ? tp('ia.unanswered', unansweredCount)
                    : undefined
                }
                onClick={submit}
                className={PRIMARY_BUTTON}
              >
                {busy ? t('ia.sending') : t('ia.submit')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={dismiss}
                className={SECONDARY_BUTTON}
              >
                {t('ia.dismiss')}
              </button>
              {unansweredCount > 0 ? (
                <span className="text-[12px] text-ink-faint">
                  {tp('ia.unanswered', unansweredCount)}
                </span>
              ) : null}
              {failed !== null ? (
                <span role="alert" className="text-[12px] text-danger">
                  {failed}
                </span>
              ) : null}
            </div>
          ) : (
            <p role="status" className="pt-1 text-[13px] font-medium text-ink-soft">
              {sent === 'answered' ? t('ia.sentToKiki') : t('ia.dismissed')}
            </p>
          )}
      </div>
    </div>
  );
}

/* ── Transcript placement: one-line records for the "Needs you" tray ───── */

/**
 * Where pending approvals/questions are answered. By default the transcript
 * renders the full interactive card in place; when the composer's "Needs you"
 * tray is mounted it provides `{ inTray: true }` and the transcript keeps
 * only a one-line record per item (the tray renders ApprovalCard/QuestionCard
 * itself). `onReview` lets the record's action focus that item in the tray.
 */
export interface InteractionPlacement {
  readonly inTray: boolean;
  readonly onReview?: (kind: 'approval' | 'question', id: string) => void;
}

export const InteractionPlacementContext = createContext<InteractionPlacement>({ inTray: false });

export function useInteractionPlacement(): InteractionPlacement {
  return useContext(InteractionPlacementContext);
}

/**
 * The transcript's one-line record of a PENDING approval/question while its
 * decision lives in the tray: a static accent dot (waiting on the user), the
 * specific ask ("Awaiting approval" / "Awaiting answer"), origin, subject,
 * and a Review action that jumps to the tray. Same line rhythm as the
 * resolved history line so a record reads as one entry whose outcome fills
 * in later. `data-interaction-record` carries the wire id so the tray's
 * "Show in timeline" can scroll to it.
 */
export function InteractionRecord({
  block,
  originName,
  onReview,
}: {
  block: ApprovalBlock | QuestionBlock;
  originName?: string;
  onReview?: () => void;
}) {
  const { t } = useI18n();
  const id = block.kind === 'approval' ? block.request.approval_id : block.request.question_id;
  const subject =
    block.kind === 'approval'
      ? `${block.request.tool_name} · ${block.request.action}`
      : (block.request.questions[0]?.question ?? t('ia.kikiAsks'));
  return (
    <div
      data-interaction-record={id}
      data-interaction-kind={block.kind}
      className="anim-enter flex min-h-7 items-center gap-2 text-[12px]"
    >
      {/* Static dot: the tray above the composer is where the waiting pulses;
          a record repeated per row would turn the column into a flicker. */}
      <span aria-hidden className="flex w-[18px] shrink-0 justify-center">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      <span className="shrink-0 font-medium text-ink">
        {t(block.kind === 'approval' ? 'ia.record.awaitingApproval' : 'ia.record.awaitingAnswer')}
      </span>
      <span className="min-w-0 truncate text-ink-faint">
        {originName === undefined ? '' : `${originName} · `}
        {subject}
      </span>
      {onReview !== undefined ? (
        <button
          type="button"
          onClick={onReview}
          aria-label={t('ia.record.reviewAria')}
          className="ml-auto inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink"
        >
          {t('ia.record.review')}
          <Icon name="arrowDown" size={12} />
        </button>
      ) : null}
    </div>
  );
}
