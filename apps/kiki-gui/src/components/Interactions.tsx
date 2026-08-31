/**
 * Approval card — the amber attention element. Hardened after aionui's
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

import { useEffect, useRef, useState } from 'react';

import type { ApprovalDecision, QuestionAnswer, QuestionItem } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import type { ApprovalBlock, QuestionBlock } from '../state/transcript';
import { Markdown } from './Markdown';

type ApprovalIntent = 'allow-once' | 'allow-always' | 'reject-once';

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

export function ApprovalCard({
  block,
  onResolve,
  originAgentName,
  showShortcutHints = false,
}: {
  block: ApprovalBlock;
  onResolve: (decision: ApprovalDecision, scope?: 'session', selectedOptionId?: string) => Promise<void>;
  /** Display name of the subagent that issued the request, when not main. */
  originAgentName?: string;
  /** y/n hints show on every pending card (focused or topmost visible wins). */
  showShortcutHints?: boolean;
}) {
  const { t, time } = useI18n();
  const [forSession, setForSession] = useState(false);
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
  }, [approvalId]);
  useEffect(
    () => () => {
      epochRef.current += 1; // unmount: late completions become no-ops
    },
    [],
  );

  if (block.resolution !== undefined) {
    const { decision } = block.resolution;
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
    const tone =
      decision === 'approved'
        ? 'border-success/40 text-success'
        : decision === 'resolved_elsewhere'
          ? 'border-hairline text-ink-faint'
          : 'border-danger/40 text-danger';
    return (
      <div
        className={`anim-enter flex items-center gap-2 rounded-lg border bg-panel px-3 py-1.5 text-[12px] ${tone}`}
      >
        <span aria-hidden>{decision === 'approved' ? '✓' : decision === 'resolved_elsewhere' ? '·' : '×'}</span>
        <span className="font-medium">{label}</span>
        <span className="truncate font-mono text-[11px] text-ink-faint">
          {block.request.tool_name} — {block.request.action}
        </span>
      </div>
    );
  }

  const external = externalPermissionFromDisplay(block.request.tool_input_display);
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

  return (
    <div
      data-approval-id={approvalId}
      className="anim-enter overflow-hidden rounded-xl border border-amber-rule/50 bg-amber-card shadow-[0_2px_12px_-6px_rgba(180,83,9,0.25)]"
    >
      <div className="flex">
        <div className="w-1 shrink-0 bg-amber-rule" />
        <div className="min-w-0 flex-1 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-amber-ink">
              {external === undefined ? t('ia.approvalNeeded') : t('ia.external.title')}
            </span>
            {external !== undefined ? (
              <span className="rounded-full border border-amber-rule/40 bg-panel px-1.5 py-px text-[10px] font-medium text-amber-ink/80">
                {t('ia.external.badge')}
              </span>
            ) : null}
            {originAgentName !== undefined ? (
              <span className="rounded-full border border-amber-rule/40 bg-panel px-1.5 py-px text-[10px] font-medium text-amber-ink/80">
                {t('ia.fromSubagent', { name: originAgentName })}
              </span>
            ) : null}
            <span className="text-[10.5px] text-amber-ink/60">
              {time.timeUntil(block.request.expires_at)}
            </span>
          </div>
          <p className="mt-1 text-[13px] text-ink">
            <span className="font-mono font-semibold">{block.request.tool_name}</span>
            <span className="text-ink-soft"> · {block.request.action}</span>
          </p>
          {detail !== undefined ? (
            <div className="mt-2">
              <p className="mb-0.5 text-[10px] font-semibold tracking-wide text-amber-ink/60 uppercase">
                {detail.label}
              </p>
              <pre className="max-h-40 overflow-auto rounded-lg border border-amber-rule/30 bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
                {detail.text}
              </pre>
            </div>
          ) : null}

          {external?.ok === true ? (
            <div className="mt-2">
              <p className="text-[13px] text-ink">{external.display.summary}</p>
              {external.display.detail !== undefined ? (
                <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg border border-amber-rule/30 bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink">
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
              <label className="mt-2.5 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-amber-ink/80">
                <input
                  type="checkbox"
                  checked={forSession}
                  disabled={submitting !== null}
                  onChange={(event) => { setForSession(event.target.checked); }}
                  className="h-3 w-3 accent-accent"
                />
                {t('ia.remember')}
              </label>

              <div className="mt-3 flex items-center gap-2" aria-busy={submitting !== null}>
                <button
                  type="button"
                  disabled={submitting !== null}
                  onClick={() => { submit('approved'); }}
                  className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
                >
                  {submitting === 'allow-once' || submitting === 'allow-always'
                    ? t('ia.approving')
                    : t('ia.approve')}{' '}
                  {showShortcutHints ? (
                    <kbd className="ml-1 rounded bg-white/20 px-1 font-mono text-[10px]">y</kbd>
                  ) : null}
                </button>
                <button
                  type="button"
                  disabled={submitting !== null}
                  onClick={() => { submit('rejected'); }}
                  className="rounded-lg border border-hairline-strong bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-danger hover:text-danger disabled:opacity-60"
                >
                  {submitting === 'reject-once' ? t('ia.rejecting') : t('ia.reject')}{' '}
                  {showShortcutHints ? (
                    <kbd className="ml-1 rounded bg-paper px-1 font-mono text-[10px]">n</kbd>
                  ) : null}
                </button>
              </div>
              {failed ? (
                <p role="alert" className="mt-2 text-[11.5px] text-danger">
                  {t('ia.sendFailed')}
                </p>
              ) : null}
            </>
            ) : external.ok ? (
              <>
                <div
                  className="mt-3 space-y-1.5"
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
                <div className="mt-2.5">
                  <button
                    type="button"
                    disabled={submittingOptionId !== null}
                    onClick={() => { submit('cancelled'); }}
                    className="rounded-lg border border-hairline-strong bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-danger hover:text-danger disabled:opacity-60"
                  >
                    {submittingOptionId === '__cancel' ? t('ia.external.cancelling') : t('ia.external.cancel')}
                  </button>
                </div>
                {failed ? (
                  <p role="alert" className="mt-2 text-[11.5px] text-danger">
                    {t('ia.sendFailed')}
                  </p>
                ) : null}
              </>
            ) : (
              /* Fail closed: the payload claims external_permission but does not
                 validate — no option may be picked, cancel stays available. */
              <>
                <p role="alert" className="mt-2 text-[12px] text-danger">
                  {t('ia.external.unknownShape')}
                </p>
                <div className="mt-2.5">
                  <button
                    type="button"
                    disabled={submittingOptionId !== null}
                    onClick={() => { submit('cancelled'); }}
                    className="rounded-lg border border-hairline-strong bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-danger hover:text-danger disabled:opacity-60"
                  >
                    {submittingOptionId === '__cancel' ? t('ia.external.cancelling') : t('ia.external.cancel')}
                  </button>
                </div>
                {failed ? (
                  <p role="alert" className="mt-2 text-[11.5px] text-danger">
                    {t('ia.sendFailed')}
                  </p>
                ) : null}
              </>
            )
          ) : (
            <p
              role="status"
              className={`mt-3 flex items-center gap-1.5 text-[12px] font-medium ${
                answered === 'approved'
                  ? 'text-success'
                  : answered === 'cancelled'
                    ? 'text-ink-faint'
                    : 'text-danger'
              }`}
            >
              <span aria-hidden>{answered === 'approved' ? '✓' : '×'}</span>
              {answered === 'approved'
                ? t('ia.resolution.approved')
                : answered === 'cancelled'
                  ? t('ia.resolution.cancelled')
                  : t('ia.resolution.rejected')}
              {t('ia.sentToKikiSuffix')}
            </p>
          )}
        </div>
      </div>
    </div>
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
    ? { icon: '✓', marker: 'border-success/50 text-success', chip: 'border-success/40 text-success' }
    : lowered.startsWith('reject')
      ? { icon: '×', marker: 'border-danger/50 text-danger', chip: 'border-danger/40 text-danger' }
      : { icon: '•', marker: 'border-hairline-strong text-ink-faint', chip: 'border-hairline text-ink-faint' };
  const changes = option.changes ?? [];
  return (
    <div
      className={`rounded-lg border bg-panel transition-colors ${
        submitting ? 'border-accent' : 'border-hairline hover:border-hairline-strong'
      }`}
    >
      <button
        type="button"
        role="radio"
        aria-checked={submitting}
        disabled={busy}
        onClick={onPick}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left disabled:opacity-60"
      >
        <span
          aria-hidden
          className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] ${tone.marker}`}
        >
          {tone.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-ink">
            {submitting ? t('ia.sending') : option.label}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${tone.chip}`}
        >
          {externalKindLabel(option.kind, t)}
        </span>
      </button>
      {changes.length > 0 ? (
        <div className="px-2.5 pb-1.5 pl-[26px]">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => { setExpanded((prev) => !prev); }}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-faint transition-colors hover:text-accent"
          >
            {tp('ia.external.changes', changes.length)}
            <span aria-hidden className="text-[9px]">{expanded ? '▴' : '▾'}</span>
          </button>
          {expanded ? (
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-amber-rule/30 bg-amber-card/50 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">
              {changes.map((change) => boundedJson(change, 300)).join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Question card (AskUserQuestion) — single/multi select per the schema, an
 * "Other" free-text path when allowed, submit + dismiss.
 */

function QuestionItemView({
  item,
  answer,
  onChange,
}: {
  item: QuestionItem;
  answer: { optionIds: string[]; otherText: string; useOther: boolean };
  onChange: (next: { optionIds: string[]; otherText: string; useOther: boolean }) => void;
}) {
  const { t } = useI18n();
  const multi = item.multi_select === true;
  const toggle = (optionId: string) => {
    if (multi) {
      const optionIds = answer.optionIds.includes(optionId)
        ? answer.optionIds.filter((id) => id !== optionId)
        : [...answer.optionIds, optionId];
      onChange({ ...answer, optionIds });
    } else {
      onChange({ ...answer, optionIds: [optionId], useOther: false });
    }
  };
  return (
    <div>
      {item.header !== undefined ? (
        <p className="text-[10.5px] font-semibold tracking-wide text-amber-ink/70 uppercase">
          {item.header}
        </p>
      ) : null}
      <p className="mt-0.5 text-[13px] font-medium text-ink">{item.question}</p>
      {item.body !== undefined ? (
        <div className="mt-1 text-[12px] text-ink-soft">
          <Markdown text={item.body} />
        </div>
      ) : null}
      <div className="mt-2 space-y-1">
        {item.options.map((option) => {
          const selected = answer.optionIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              onClick={() => { toggle(option.id); }}
              className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                selected
                  ? 'border-accent bg-accent-soft'
                  : 'border-hairline bg-panel hover:border-hairline-strong'
              }`}
            >
              <span
                aria-hidden
                className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[9px] ${
                  multi ? 'rounded-[4px]' : 'rounded-full'
                } ${selected ? 'border-accent bg-accent text-white' : 'border-hairline-strong bg-panel'}`}
              >
                {selected ? '✓' : ''}
              </span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-ink">{option.label}</span>
                {option.description !== undefined ? (
                  <span className="block text-[11.5px] text-ink-soft">{option.description}</span>
                ) : null}
              </span>
            </button>
          );
        })}
        {item.allow_other === true ? (
          <div
            className={`rounded-lg border px-2.5 py-1.5 ${
              answer.useOther ? 'border-accent bg-accent-soft' : 'border-hairline bg-panel'
            }`}
          >
            <button
              type="button"
              aria-pressed={answer.useOther}
              onClick={() => { onChange({ ...answer, useOther: !answer.useOther }); }}
              className="flex w-full items-center gap-2 text-left"
            >
              <span
                aria-hidden
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] ${
                  answer.useOther ? 'border-accent bg-accent text-white' : 'border-hairline-strong'
                }`}
              >
                {answer.useOther ? '✓' : ''}
              </span>
              <span className="text-[12.5px] font-medium text-ink">
                {item.other_label ?? t('ia.other')}
              </span>
            </button>
            {answer.useOther ? (
              <input
                className="mt-1.5 w-full rounded-md border border-hairline bg-panel px-2 py-1 text-[12px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
                placeholder={item.other_description ?? t('ia.otherPlaceholder')}
                value={answer.otherText}
                onChange={(event) => { onChange({ ...answer, otherText: event.target.value }); }}
              />
            ) : null}
          </div>
        ) : null}
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
  const [selections, setSelections] = useState<
    Record<string, { optionIds: string[]; otherText: string; useOther: boolean }>
  >({});
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
      <div className="anim-enter flex items-center gap-2 rounded-lg border border-hairline bg-panel px-3 py-1.5 text-[12px] text-ink-faint">
        <span aria-hidden>·</span>
        <span className="font-medium">{label}</span>
      </div>
    );
  }

  const answerFor = (id: string) =>
    selections[id] ?? { optionIds: [] as string[], otherText: '', useOther: false };

  const isItemAnswered = (item: (typeof block.request.questions)[number]): boolean => {
    const selection = answerFor(item.id);
    if (selection.useOther) return selection.otherText.trim() !== '';
    return selection.optionIds.length > 0;
  };
  // Gate submit: unanswered sub-questions would be silently dropped from the
  // payload (and the server rejects partial answers with 40001 anyway).
  const unansweredCount = block.request.questions.filter((item) => !isItemAnswered(item)).length;

  const submit = () => {
    if (unansweredCount > 0) return;
    const answers: Record<string, QuestionAnswer> = {};
    for (const item of block.request.questions) {
      const selection = answerFor(item.id);
      const multi = item.multi_select === true;
      if (selection.useOther && multi) {
        answers[item.id] = {
          kind: 'multi_with_other',
          option_ids: selection.optionIds,
          other_text: selection.otherText,
        };
      } else if (selection.useOther) {
        answers[item.id] = { kind: 'other', text: selection.otherText };
      } else if (multi) {
        if (selection.optionIds.length === 0) continue;
        answers[item.id] = { kind: 'multi', option_ids: selection.optionIds };
      } else {
        const first = selection.optionIds[0];
        if (first === undefined) continue;
        answers[item.id] = { kind: 'single', option_id: first };
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
    <div className="anim-enter overflow-hidden rounded-xl border border-amber-rule/50 bg-amber-card">
      <div className="flex">
        <div className="w-1 shrink-0 bg-amber-rule" />
        <div className="min-w-0 flex-1 space-y-4 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-amber-ink">{t('ia.kikiAsks')}</span>
            {originAgentName !== undefined ? (
              <span className="rounded-full border border-amber-rule/40 bg-panel px-1.5 py-px text-[10px] font-medium text-amber-ink/80">
                {t('ia.fromSubagent', { name: originAgentName })}
              </span>
            ) : null}
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
                className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:opacity-60"
              >
                {busy ? t('ia.sending') : t('ia.submit')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={dismiss}
                className="rounded-lg border border-hairline-strong bg-panel px-3.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:text-danger disabled:opacity-60"
              >
                {t('ia.dismiss')}
              </button>
              {unansweredCount > 0 ? (
                <span className="text-[11px] text-amber-ink/70">
                  {tp('ia.unanswered', unansweredCount)}
                </span>
              ) : null}
              {failed !== null ? (
                <span role="alert" className="text-[11.5px] text-danger">
                  {failed}
                </span>
              ) : null}
            </div>
          ) : (
            <p role="status" className="pt-1 text-[12px] font-medium text-success">
              <span aria-hidden>✓</span>{' '}
              {sent === 'answered' ? t('ia.sentToKiki') : t('ia.dismissed')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
