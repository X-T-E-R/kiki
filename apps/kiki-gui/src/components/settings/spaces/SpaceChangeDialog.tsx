import { useCallback, useEffect, useRef, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import type { SpaceMutationResponse, SpacePlanRequest, SpacePreview } from '@kiki/protocol';

import { useI18n } from '../../../i18n';
import {
  spaceBlockedReasonText,
  spaceItemLabel,
  spacePreviewSections,
  spacePreviewSelectable,
  spaceSettingsApi,
  spaceValueLabel,
  type SpacePreviewRow,
  type SpaceSettingsTarget,
  spaceSettingsClientKey,
} from '../../../lib/spaceSettings';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../../controls';
import { Dialog, DIALOG_PANEL_BASE, DIALOG_PANEL_SIZES } from '../../Dialog';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';

const ACTION = { follow: 'follow', fixed: 'fixed', push: 'push-to-main', edit: 'edit', exclude: 'exclude' } as const;
type DialogAction = (typeof ACTION)[keyof typeof ACTION];

const TITLE: Record<DialogAction, 'st.spaces.change.followTitle' | 'st.spaces.change.fixedTitle' | 'st.spaces.change.pushTitle' | 'st.spaces.change.editTitle'> = {
  follow: 'st.spaces.change.followTitle',
  fixed: 'st.spaces.change.fixedTitle',
  'push-to-main': 'st.spaces.change.pushTitle',
  edit: 'st.spaces.change.editTitle',
  exclude: 'st.spaces.change.fixedTitle',
};

const BODY: Record<DialogAction, 'st.spaces.change.followBody' | 'st.spaces.change.fixedBody' | 'st.spaces.change.pushBody' | 'st.spaces.change.editBody'> = {
  follow: 'st.spaces.change.followBody',
  fixed: 'st.spaces.change.fixedBody',
  'push-to-main': 'st.spaces.change.pushBody',
  edit: 'st.spaces.change.editBody',
  exclude: 'st.spaces.change.fixedBody',
};

/**
 * One dialog for every way a space's setting can change (design §4.3–§4.5).
 * The server's preview is the list: cancelling writes nothing, a row that is
 * unchecked keeps its current value, and the plan is applied by token, so a
 * change made elsewhere between preview and apply is refused rather than
 * half-written. "Update the main space" is its own step inside this panel, not
 * a side effect of following.
 */
interface SpaceChangeDialogProps {
  target: SpaceSettingsTarget;
  spaceName: string;
  canPush: boolean;
  request: SpacePlanRequest;
  onClose: () => void;
  onApplied: (result: SpaceMutationResponse) => void;
}

export function SpaceChangeDialog(props: SpaceChangeDialogProps) {
  const { client, identity } = props.target;
  return <SpaceChangeDialogContext key={`${spaceSettingsClientKey(client)}|${identity.serverId}|${identity.homeId}`} {...props} />;
}

function SpaceChangeDialogContext({ target, spaceName, canPush, request, onClose, onApplied }: {
  target: SpaceSettingsTarget;
  spaceName: string;
  /** A child space can offer the push path; the main space has nothing above it. */
  canPush: boolean;
  request: SpacePlanRequest;
  onClose: () => void;
  onApplied: (result: SpaceMutationResponse) => void;
}) {
  const { client, identity } = target;
  const spaceId = identity.homeId;
  const active = useRef(false);
  const loadSequence = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; loadSequence.current += 1; };
  }, []);
  const { t, locale } = useI18n();
  const [action, setAction] = useState<DialogAction>(request.action);
  const [preview, setPreview] = useState<SpacePreview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showSame, setShowSame] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  // The request and the client are read at call time: the caller builds a
  // fresh object each render, and only its content should cause a new plan.
  const requestRef = useRef(request);
  requestRef.current = request;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const clientRef = useRef(client);
  clientRef.current = client;
  const requestKey = JSON.stringify({ items: request.items, groups: request.groups, changes: request.changes });

  const load = useCallback((next: DialogAction) => {
    const current = requestRef.current;
    const previous = selectedRef.current;
    const sequence = ++loadSequence.current;
    const currentLoad = () => active.current && sequence === loadSequence.current;
    setLoading(true);
    setPreview(null);
    setSelected(new Set());
    setError(null);
    void spaceSettingsApi(clientRef.current)
      .preview(spaceId, { action: next, items: current.items, groups: current.groups, changes: current.changes })
      .then((plan) => {
        if (!currentLoad()) return;
        setPreview(plan);
        setSelected(new Set(plan.rows
          .filter((row) => {
            if (!spacePreviewSelectable(row)) return false;
            // Pushing keeps the boxes the person already ticked; a row the main
            // space also changed is never chosen for them.
            if (next === ACTION.push) return !row.conflict && previous.has(row.id);
            return row.selected;
          })
          .map((row) => row.id)));
      })
      .catch((error: unknown) => { if (currentLoad()) setError(error); })
      .finally(() => { if (currentLoad()) setLoading(false); });
  }, [spaceId, requestKey]);

  useEffect(() => { load(action); }, [load, action, nonce]);

  const sections = preview === null ? null : spacePreviewSections(preview);
  const checkedItems = preview === null ? 0 : preview.rows.filter((row) => !row.id.startsWith('group:') && selected.has(row.id)).length;
  const checkedGroups = preview === null ? 0 : preview.rows.filter((row) => row.id.startsWith('group:') && selected.has(row.id)).length;
  const selectable = preview === null ? 0 : preview.rows.filter((row) => spacePreviewSelectable(row)).length;
  const canApply = selected.size > 0 && !busy;

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const apply = async () => {
    if (preview === null || !canApply) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await spaceSettingsApi(client).apply(spaceId, { token: preview.token, selected: [...selected] });
      if (!active.current) return;
      onApplied(result);
      onClose();
    } catch (error) {
      if (active.current) setFeedback({ tone: 'error', text: t('st.spaces.change.failed', { reason: errorText(locale, error) }) });
    } finally {
      if (active.current) setBusy(false);
    }
  };

  const primaryLabel = action === ACTION.push
    ? t('st.spaces.change.pushConfirm')
    : checkedItems > 0
      ? t('st.spaces.change.apply', { count: checkedItems })
      : t('st.spaces.change.saveChoice');

  const row = (candidate: SpacePreviewRow) => {
    const blocked = candidate.blocked_reason;
    const checked = selected.has(candidate.id);
    return (
      <li key={candidate.id}>
        <label data-space-change-row={candidate.id} data-space-change-state={blocked === undefined ? (checked ? 'on' : 'off') : 'blocked'}
          className={`flex items-start gap-3 py-2 ${blocked === undefined ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
          <input type="checkbox" disabled={blocked !== undefined} checked={blocked === undefined && checked}
            onChange={() => { toggle(candidate.id); }}
            className="mt-0.5 accent-[var(--color-selected-ink)]" />
          <span className="min-w-0 flex-1">
            <span className={`block text-[13px] ${blocked === undefined ? 'text-ink' : 'text-ink-faint'}`}>{spaceItemLabel(candidate.id, candidate.name, t)}</span>
            {candidate.conflict ? <span className="mt-0.5 block text-[12px] leading-4 text-amber-ink">{t('st.spaces.change.mainChanged')}</span> : null}
            {blocked !== undefined ? <span className="mt-0.5 block text-[12px] leading-4 text-ink-faint">{spaceBlockedReasonText(blocked, t)}</span> : null}
            {blocked === undefined && candidate.selected && !checked ? <span className="mt-0.5 block text-[12px] leading-4 text-ink-faint">{t('st.spaces.change.kept')}</span> : null}
          </span>
          <span className="grid shrink-0 grid-cols-[auto_minmax(0,8rem)] gap-x-2 text-[12px] leading-5">
            <span className="text-ink-faint">{action === ACTION.push ? t('st.spaces.change.mainNow') : t('st.spaces.change.now')}</span>
            <span className="truncate text-right text-ink-soft" title={spaceValueLabel(candidate.id, candidate.before, t)}>
              {spaceValueLabel(candidate.id, candidate.before, t)}
            </span>
            <span className="text-ink-faint">{t('st.spaces.change.becomes')}</span>
            <span className="truncate text-right text-ink" title={spaceValueLabel(candidate.id, candidate.after, t)}>
              {spaceValueLabel(candidate.id, candidate.after, t)}
            </span>
          </span>
        </label>
      </li>
    );
  };

  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} ariaLabel={t(TITLE[action])} overlayId="space-change-dialog"
      panelClassName={`${DIALOG_PANEL_BASE} ${DIALOG_PANEL_SIZES.md} max-h-[calc(100dvh-2rem)] overflow-y-auto`}>
      <div data-space-change-dialog={action}>
        <h2 className="font-display text-[17px] font-semibold text-ink">{t(TITLE[action])}</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{t(BODY[action])}</p>
        <p className="mt-1 text-[12px] text-ink-faint">{spaceName}</p>

        {loading ? <p className="mt-4 text-[12px] text-ink-faint">{t('st.spaces.change.loading')}</p> : null}
        {error !== null ? (
          <div className="mt-4 space-y-2">
            <InlineError error={error} />
            <button type="button" className={SECONDARY_BUTTON} onClick={() => { setNonce((value) => value + 1); }}>{t('st.spaces.change.reload')}</button>
          </div>
        ) : null}

        {sections !== null && !loading ? (
          <>
            {selectable === 0 ? <p className="mt-4 text-[12px] text-ink-faint" data-space-change-empty>{t('st.spaces.change.nothingToChange')}</p> : null}
            <ul className="mt-3" data-space-change-rows data-space-plan={preview?.action}>{sections.changed.map(row)}</ul>

            {sections.same.length > 0 ? (
              <div className="mt-2 border-t border-hairline pt-2">
                <button type="button" data-space-change-same-toggle aria-expanded={showSame}
                  className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[12px] text-ink-soft outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink"
                  onClick={() => { setShowSame((value) => !value); }}>
                  <span aria-hidden className={`transition-transform ${showSame ? 'rotate-90' : ''}`}>›</span>
                  {t('st.spaces.change.same', { count: sections.same.length })}
                </button>
                {showSame ? <ul data-space-change-same-rows>{sections.same.map(row)}</ul> : null}
              </div>
            ) : null}

            {sections.groups.length > 0 ? (
              <div className="mt-3 border-t border-hairline pt-2">
                <ul data-space-change-group-rows>
                  {sections.groups.map((group) => (
                    <li key={group.id}>
                      <label data-space-change-row={group.id} className="flex cursor-pointer items-start gap-3 py-2">
                        <input type="checkbox" checked={selected.has(group.id)} onChange={() => { toggle(group.id); }}
                          className="mt-0.5 accent-[var(--color-selected-ink)]" />
                        <span className="min-w-0 flex-1 text-[13px] text-ink">{t('st.spaces.change.futureItems')}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {action !== ACTION.push && checkedItems === 0 && checkedGroups === 0 ? (
              <p className="mt-3 text-[12px] text-ink-faint">{t('st.spaces.change.none')}</p>
            ) : null}
          </>
        ) : null}

        <div className="mt-3"><FeedbackLine feedback={feedback} /></div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {action === ACTION.push ? (
              <button type="button" data-space-change-back className={LINK_BUTTON} onClick={() => { setAction(ACTION.follow); }}>
                {t('st.spaces.change.back')}
              </button>
            ) : canPush && selectable > 0 ? (
              <button type="button" data-space-change-push className={LINK_BUTTON} onClick={() => { setAction(ACTION.push); }}>
                {t('st.spaces.change.pushAction')}
              </button>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" data-space-change-cancel className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
            <button type="button" data-space-change-apply className={PRIMARY_BUTTON} disabled={!canApply} onClick={() => { void apply(); }}>
              {busy ? t('common.saving') : primaryLabel}
            </button>
          </div>
        </div>

        {preview?.restart_required === true ? <Hint>{t('st.spaces.change.restart')}</Hint> : null}
      </div>
    </Dialog>
  );
}

const LINK_BUTTON = 'rounded px-1 py-0.5 text-left text-[12px] font-medium text-ink-soft underline decoration-hairline-strong underline-offset-2 outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink';
