import { memo, useId, useMemo, useState, type ReactNode } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import {
  buildDiagnosticClipboardText,
  decodeFullDiagnostic,
  isMeaningfulUserErrorCode,
  type DiagnosticCategory,
} from '../agent-panel/failureText';
import { DisclosureChevron } from '../icons';
import { RelativeTime } from '../RelativeTime';
import { CopyButton } from './ContentCopyButton';

export interface TimelineErrorAction {
  readonly id: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly primary?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly title?: string;
  readonly dataAttr?: string;
  readonly attrs?: Record<string, string | undefined>;
  readonly navigation?: boolean;
  readonly keepWhenSuperseded?: boolean;
  readonly confirmMessage?: string;
  readonly confirmLabel?: string;
}

export interface TimelineErrorCalloutProps {
  readonly incidentId: string;
  readonly severity?: 'error' | 'warn';
  readonly title?: string;
  readonly message?: string;
  readonly errorDetails?: string;
  readonly createdAt?: string;
  readonly superseded?: boolean;
  readonly announce?: boolean;
  readonly prepareCopy?: (signal: AbortSignal) => Promise<string>;
  readonly actions?: readonly TimelineErrorAction[];
  readonly extraMeta?: ReactNode;
  readonly attrs?: Record<string, string | number | boolean | undefined>;
  readonly defaultRawOpen?: boolean;
  readonly rawOpen?: boolean;
  readonly onToggleRawOpen?: () => void;
  readonly className?: string;
}

const CATEGORY_TITLE_KEY: Readonly<Record<DiagnosticCategory, I18nKey | undefined>> = {
  capacity: 'transcript.error.capacity',
  rate_limit: 'transcript.error.rateLimit',
  quota: 'transcript.error.quota',
  service: 'transcript.error.service',
  auth: 'transcript.error.auth',
  permission: 'transcript.error.permission',
  context_limit: 'transcript.error.contextLimit',
  thinking_truncated: 'transcript.error.thinkingTruncated',
  empty_response: 'transcript.error.emptyResponse',
  unknown: undefined,
};

const QUIET_COPY_BTN =
  '!min-h-6 !border-transparent !bg-transparent !px-1.5 !text-ink-faint hover:!border-transparent hover:!bg-ink/[0.05] hover:!text-ink';

const ACTION_BASE =
  'inline-flex min-h-7 min-w-7 cursor-pointer items-center justify-center gap-1 rounded-[6px] px-2.5 text-[13px] leading-[20px] font-normal transition-colors duration-[var(--kiki-motion-quick)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-default disabled:opacity-55 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-3';

const ACTION_PRIMARY =
  `${ACTION_BASE} border border-hairline-strong bg-ink/[0.06] text-ink hover:bg-ink/[0.11]`;

const ACTION_SECONDARY =
  `${ACTION_BASE} border border-hairline bg-paper text-ink-soft hover:border-hairline-strong hover:bg-ink/[0.04] hover:text-ink`;

const DISCLOSE_BTN =
  'inline-flex min-h-7 min-w-7 cursor-pointer items-center gap-1 rounded-[6px] px-2 text-[12px] leading-[16px] font-normal text-ink-soft transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink pointer-coarse:min-h-11 pointer-coarse:min-w-11';

export const TimelineErrorCallout = memo(function TimelineErrorCallout({
  incidentId,
  severity = 'error',
  title,
  message,
  errorDetails,
  createdAt,
  superseded = false,
  announce = false,
  prepareCopy,
  actions = [],
  extraMeta,
  attrs,
  defaultRawOpen = false,
  rawOpen: controlledRawOpen,
  onToggleRawOpen,
  className = '',
}: TimelineErrorCalloutProps) {
  const { t, time } = useI18n();
  const [expandedSuperseded, setExpandedSuperseded] = useState(false);
  const [localRawOpen, setLocalRawOpen] = useState(defaultRawOpen);
  const [confirmActionId, setConfirmActionId] = useState<string | null>(null);
  const rawPanelId = useId();
  const bodyPanelId = useId();

  const rawOpen = controlledRawOpen ?? localRawOpen;
  const toggleRaw = onToggleRawOpen ?? (() => { setLocalRawOpen((value) => !value); });

  const diagnostic = useMemo(
    () => decodeFullDiagnostic(message, errorDetails),
    [message, errorDetails],
  );

  const categoryKey = CATEGORY_TITLE_KEY[diagnostic.category];
  const resolvedTitle = title ?? (categoryKey !== undefined ? t(categoryKey) : t('notice.turnFailed'));
  const rawDecodedMessage = diagnostic.decodedMessage !== ''
    ? diagnostic.decodedMessage
    : t('transcript.error.noReason');
  const humanizedBody = useMemo(() => {
    if (diagnostic.category === 'thinking_truncated' && /^The API returned a response containing only thinking content/i.test(rawDecodedMessage)) {
      return t('transcript.error.thinkingTruncatedBody');
    }
    if (diagnostic.category === 'empty_response' && /^The API returned an empty response/i.test(rawDecodedMessage)) {
      return t('transcript.error.emptyResponseBody');
    }
    if (rawDecodedMessage.trim() === 'Turn ended') {
      return t('transcript.error.turnEndedSteerBody');
    }
    return undefined;
  }, [diagnostic.category, rawDecodedMessage, t]);
  const displayMessage = humanizedBody ?? rawDecodedMessage;

  const clipboardText = useMemo(
    () => buildDiagnosticClipboardText(diagnostic, resolvedTitle),
    [diagnostic, resolvedTitle],
  );

  const visibleCode = isMeaningfulUserErrorCode(diagnostic.code) ? diagnostic.code : undefined;
  const hasMeta = visibleCode !== undefined || diagnostic.status !== undefined || diagnostic.requestId !== undefined;
  const dotColor = superseded
    ? 'bg-ink-faint/60'
    : severity === 'warn'
      ? 'bg-amber-ink/75'
      : 'bg-danger/75';
  const surfaceClass = superseded
    ? 'rounded-[8px] border border-hairline/75 bg-surface-subtle/35 px-3 py-1.5'
    : 'rounded-[10px] border border-hairline bg-surface-subtle/60 px-3.5 py-2.5';

  const visibleActions = superseded
    ? actions.filter((action) => action.navigation === true || action.keepWhenSuperseded === true)
    : actions;
  const confirmAction = confirmActionId === null ? undefined : visibleActions.find((action) => action.id === confirmActionId);
  const messageLineCount = displayMessage.split('\n').length;
  const hasLongHeadlineBody = messageLineCount > 2 || displayMessage.length > 220;
  const rawDiagnosticFallback = humanizedBody !== undefined ? (diagnostic.rawEnvelope ?? rawDecodedMessage) : undefined;
  const effectiveRawText = diagnostic.rawEnvelope ?? rawDiagnosticFallback ?? (hasLongHeadlineBody ? displayMessage : undefined);
  const showRawDisclosure = effectiveRawText !== undefined && (diagnostic.hasDistinctRaw || humanizedBody !== undefined || hasLongHeadlineBody);

  if (superseded && !expandedSuperseded) {
    return (
      <div
        data-timeline-error-callout={incidentId}
        data-error-severity={severity}
        data-error-category={diagnostic.category}
        data-error-superseded="true"
        className={`anim-enter ${surfaceClass} font-sans ${className}`.trimEnd()}
        {...attrs}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
          <span className="min-w-0 font-sans text-[13px] leading-[20px] font-normal text-ink-soft">
            {resolvedTitle}
          </span>
          {createdAt !== undefined ? (
            <span className="shrink-0 font-sans text-[12px] leading-[16px] font-normal tabular-nums text-ink-faint" title={time.absoluteTime(createdAt)}>
              <RelativeTime at={createdAt} />
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1">
            {visibleActions.map((action) => (
              <button
                key={action.id}
                type="button"
                data-error-action={action.id}
                {...(action.dataAttr !== undefined ? { [action.dataAttr]: '' } : {})}
                {...(action.attrs ?? {})}
                disabled={action.disabled === true || action.busy === true}
                title={action.title}
                onClick={action.onClick}
                className={DISCLOSE_BTN}
              >
                {action.label}
              </button>
            ))}
            <CopyButton
              text={clipboardText}
              prepare={prepareCopy}
              label={resolvedTitle}
              showLabel
              visibleLabel={t('cb.copy')}
              className={QUIET_COPY_BTN}
            />
            <button
              type="button"
              data-error-expand
              aria-expanded={false}
              aria-controls={bodyPanelId}
              onClick={() => { setExpandedSuperseded(true); }}
              className={DISCLOSE_BTN}
            >
              <span>{t('transcript.error.expand')}</span>
              <DisclosureChevron open={false} />
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-timeline-error-callout={incidentId}
      data-error-severity={severity}
      data-error-category={diagnostic.category}
      data-error-superseded={superseded ? 'true' : undefined}
      role={!superseded && announce ? 'alert' : undefined}
      className={`anim-enter ${surfaceClass} font-sans ${className}`.trimEnd()}
      {...attrs}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
        <span data-error-title className="min-w-0 font-sans text-[13px] leading-[20px] font-bold text-ink">
          {resolvedTitle}
        </span>
        {createdAt !== undefined ? (
          <span className="shrink-0 font-sans text-[12px] leading-[16px] font-normal tabular-nums text-ink-faint" title={time.absoluteTime(createdAt)}>
            <RelativeTime at={createdAt} />
          </span>
        ) : null}
        {extraMeta !== undefined ? (
          <span className="shrink-0 font-sans text-[12px] leading-[16px] font-normal text-ink-faint">
            {extraMeta}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CopyButton
            text={clipboardText}
            prepare={prepareCopy}
            label={resolvedTitle}
            showLabel
            visibleLabel={t('cb.copy')}
            className={QUIET_COPY_BTN}
          />
          {superseded ? (
            <button
              type="button"
              data-error-collapse
              aria-expanded={true}
              aria-controls={bodyPanelId}
              onClick={() => { setExpandedSuperseded(false); }}
              className={DISCLOSE_BTN}
            >
              <span>{t('transcript.error.collapse')}</span>
              <DisclosureChevron open={true} />
            </button>
          ) : null}
        </span>
      </div>

      <div id={bodyPanelId} className="mt-1 space-y-1.5 pl-3.5">
        <p
          data-error-message
          className={`select-text font-sans text-[13px] leading-[20px] font-normal whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-soft ${
            hasLongHeadlineBody && !rawOpen ? 'line-clamp-2' : ''
          }`.trimEnd()}
        >
          {displayMessage}
        </p>

        {hasMeta ? (
          <div
            data-error-meta
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 select-text font-mono text-[12px] leading-[16px] font-normal [overflow-wrap:anywhere] text-ink-faint"
          >
            {visibleCode !== undefined ? (
              <span>{t('transcript.error.codeLabel')}: {visibleCode}</span>
            ) : null}
            {diagnostic.status !== undefined ? (
              <span>{t('transcript.error.statusLabel')}: {diagnostic.status}</span>
            ) : null}
            {diagnostic.requestId !== undefined ? (
              <span>{t('transcript.error.requestIdLabel')}: {diagnostic.requestId}</span>
            ) : null}
          </div>
        ) : null}

        {visibleActions.length > 0 || showRawDisclosure ? (
          <div data-error-actions className="flex flex-wrap items-center gap-2 pt-0.5">
            {visibleActions.map((action) => (
              <button
                key={action.id}
                type="button"
                data-error-action={action.id}
                {...(action.dataAttr !== undefined ? { [action.dataAttr]: '' } : {})}
                {...(action.attrs ?? {})}
                disabled={action.disabled === true || action.busy === true}
                aria-busy={action.busy === true ? true : undefined}
                title={action.title}
                onClick={() => {
                  if (action.confirmMessage !== undefined) {
                    setConfirmActionId((prev) => (prev === action.id ? null : action.id));
                    return;
                  }
                  setConfirmActionId(null);
                  action.onClick();
                }}
                className={action.primary === true ? ACTION_PRIMARY : ACTION_SECONDARY}
              >
                {action.label}
              </button>
            ))}
            {showRawDisclosure ? (
              <button
                type="button"
                data-error-raw-toggle
                aria-expanded={rawOpen}
                aria-controls={rawPanelId}
                onClick={toggleRaw}
                className={DISCLOSE_BTN}
              >
                <span>{rawOpen ? t('transcript.error.rawDetailsHide') : t('transcript.error.rawDetails')}</span>
                <DisclosureChevron open={rawOpen} />
              </button>
            ) : null}
          </div>
        ) : null}

        {!superseded && confirmAction !== undefined && confirmAction.confirmMessage !== undefined ? (
          <div
            data-error-confirm={confirmAction.id}
            className="flex flex-wrap items-center gap-2 border-l border-amber-rule pl-2.5 text-[12px] leading-[16px] font-normal text-ink-soft"
          >
            <span>{confirmAction.confirmMessage}</span>
            <button
              type="button"
              data-error-confirm-accept={confirmAction.id}
              onClick={() => {
                setConfirmActionId(null);
                confirmAction.onClick();
              }}
              className={ACTION_PRIMARY}
            >
              {confirmAction.confirmLabel ?? confirmAction.label}
            </button>
            <button
              type="button"
              data-error-confirm-cancel
              onClick={() => { setConfirmActionId(null); }}
              className={ACTION_SECONDARY}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : null}

        {showRawDisclosure && rawOpen && effectiveRawText !== undefined ? (
          <pre
            id={rawPanelId}
            data-error-raw-details
            className="max-h-64 overflow-auto rounded-[4px] border border-hairline bg-panel px-2.5 py-2 select-text font-mono text-[12px] leading-[16px] font-normal whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-soft"
          >
            {effectiveRawText}
          </pre>
        ) : null}
      </div>
    </div>
  );
});
