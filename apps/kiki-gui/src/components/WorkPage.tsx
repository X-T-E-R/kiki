/**
 * WorkPage — the working surface of the Work mode in this window.
 *
 * It is deliberately a page, not a dashboard and not a market. The mode is
 * only worth something if the user can start real office work from it, so the
 * page leads with the kinds of task this mode exists for, each of which fills
 * the ordinary new-session draft and lets the user press send — the same path
 * `/new` uses, with the same composer underneath. Nothing here creates a
 * second session mechanism, and the seat's element type matches `/new`'s so the
 * textarea survives the flip into a running session.
 *
 * Model, profile and permissions stay in the existing controls. A mode changes
 * what this window suggests next; it does not hand the user a second settings
 * surface to learn.
 */

import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import type { WorkPresetItem } from '@kiki/protocol';

import { useI18n } from '../i18n';
import { useConversationShell, useRegisterSeat, type ConversationSeat } from './ConversationShell';
import { Composer } from './Composer';
import { ContextBreakdownProvider } from './ContextMeter';
import { Icon, type IconName } from './icons';
import { isAbsoluteCwdPath, useNewSessionDraft } from './NewSessionDraft';
import { WorkModeMenu, type WorkModeMenuProps } from './WorkModeMenu';
import { useWorkModes, useWindowModeId, workPresetsEnabled } from '../lib/workModeCatalog';
import { useConnection } from '../state/connection';

type TaskId = 'review' | 'draft' | 'extract' | 'tables';

interface TaskSpec {
  readonly id: TaskId;
  readonly icon: IconName;
  readonly labelKey: 'workHome.task.review' | 'workHome.task.draft' | 'workHome.task.extract' | 'workHome.task.tables';
  readonly bodyKey: 'workHome.task.reviewBody' | 'workHome.task.draftBody' | 'workHome.task.extractBody' | 'workHome.task.tablesBody';
}

const TASKS: readonly TaskSpec[] = [
  { id: 'review', icon: 'read', labelKey: 'workHome.task.review', bodyKey: 'workHome.task.reviewBody' },
  { id: 'draft', icon: 'edit', labelKey: 'workHome.task.draft', bodyKey: 'workHome.task.draftBody' },
  { id: 'extract', icon: 'notes', labelKey: 'workHome.task.extract', bodyKey: 'workHome.task.extractBody' },
  { id: 'tables', icon: 'board', labelKey: 'workHome.task.tables', bodyKey: 'workHome.task.tablesBody' },
];

export interface WorkPageProps {
  /** App-level: the one Work setup sheet, shared by every entry point. */
  readonly onSetupMode: (mode: WorkPresetItem) => void;
  readonly modeMenu?: Omit<WorkModeMenuProps, 'catalog' | 'onSetup'>;
  /** The host's own flag; the surface is only offered where it is on. */
  readonly enabled?: boolean;
}

export function WorkPage({ onSetupMode, modeMenu, enabled = true }: WorkPageProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { slots } = useConversationShell();
  const { client, meta } = useConnection();
  const on = enabled && workPresetsEnabled(meta);
  const catalog = useWorkModes(client, on);
  const [modeId] = useWindowModeId();
  const state = useNewSessionDraft();

  const mode = useMemo(() => catalog.items.find((item) => item.id === modeId), [catalog.items, modeId]);

  const cwd = state.cwd.trim();
  const sendDisabled = cwd !== ''
    ? !isAbsoluteCwdPath(cwd)
    : state.effectiveWorkspace === undefined && !state.autoWorkspace;
  const showTargetHint = sendDisabled && !state.workspacesLoading;
  const mentionScopeKey = cwd !== '' ? `cwd:${cwd}` : `ws:${state.effectiveWorkspace?.id ?? ''}`;

  const fsSearch = useMemo(() => (
    cwd !== '' || state.effectiveWorkspace !== undefined
      ? (query: string) => {
          const target = cwd !== '' ? cwd : state.effectiveWorkspace!.id;
          return client === undefined
            ? Promise.resolve([])
            : client.workspaceFsSearch(target, { query, limit: 30 }).then((result) => result.items);
        }
      : undefined
  ), [client, cwd, state.effectiveWorkspace]);

  const seat: ConversationSeat = useMemo(
    () => ({
      phase: 'hero',
      composer: (
        <ContextBreakdownProvider value={undefined}>
          <Composer
            busy={state.busy}
            disabled={state.busy}
            sendDisabled={sendDisabled}
            sendDisabledTitle={showTargetHint ? t('new.noTargetHint') : undefined}
            value={state.draft}
            onChange={state.updateDraft}
            model={state.modelOverride}
            defaultModel={undefined}
            serverDefaultModel={state.inheritedDefault}
            modelSource={state.modelSource}
            agentProfile={state.agentProfile}
            onChangeAgentProfile={state.setAgentProfile}
            execution={state.execution}
            onChangeExecution={state.setExecution}
            permissionMode={state.permissionMode}
            planMode={state.planMode}
            goalObjective={state.goalObjective}
            efforts={state.supportedEfforts}
            effort={state.effectiveEffort}
            busyPlaceholder={t('new.creating')}
            workspaceId={cwd === '' ? state.effectiveWorkspace?.id : undefined}
            agentProfileCatalogMode={state.agentProfileCatalogMode}
            fsSearch={fsSearch}
            attachments={state.attachments}
            onChangeAttachments={state.setAttachments}
            mentionScopeKey={mentionScopeKey}
            onChangeModel={state.setModelOverride}
            onChangePermissionMode={state.setPermissionMode}
            onChangePlanMode={state.setPlanMode}
            onChangeGoalObjective={state.setGoalObjective}
            onChangeEffort={state.setEffortOverride}
            onSend={state.send}
            onActivateSkill={state.activateSkill}
          />
        </ContextBreakdownProvider>
      ),
    }),
    [
      state.busy, sendDisabled, showTargetHint, state.draft, state.updateDraft, state.modelOverride,
      state.agentProfile, state.setAgentProfile, state.execution, state.setExecution,
      state.inheritedDefault, state.modelSource, state.permissionMode, state.planMode,
      state.goalObjective, state.supportedEfforts, state.effectiveEffort, cwd,
      state.effectiveWorkspace, state.agentProfileCatalogMode, fsSearch, state.attachments,
      state.setAttachments, mentionScopeKey, state.setModelOverride, state.setPermissionMode,
      state.setPlanMode, state.setGoalObjective, state.setEffortOverride, state.send,
      state.activateSkill, t,
    ],
  );
  useRegisterSeat(seat);

  return (
    <>
      {slots.header !== null
        ? createPortal(
            <div className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
              <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
                {mode?.name ?? t('workHome.eyebrow')}
              </h1>
              <WorkModeMenu catalog={catalog} onSetup={onSetupMode} {...modeMenu} />
            </div>,
            slots.header,
          )
        : null}      <div className="mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)] px-6 pb-5 pt-7 text-left" data-work-page>
        <p className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.11em] text-accent-ink">
          <span aria-hidden className="inline-block h-2 w-2 rounded-[2px] bg-accent" />
          {t('workHome.eyebrow')}
        </p>
        <h2
          className="mt-3 font-display text-[26px] font-semibold leading-[1.15] tracking-tight text-ink"
          style={{ fontVariationSettings: '"opsz" 32' }}
        >
          {t('workHome.headline')}
        </h2>
        <p className="mt-2.5 max-w-[52ch] text-[13.5px] leading-[1.6] text-ink-soft">{t('workHome.subhead')}</p>

        <div className="mt-6 flex items-center justify-between border-t border-hairline pt-4">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-section-ink">{t('workHome.startHeading')}</p>
          <button
            type="button"
            onClick={() => { navigate('/new'); }}
            className="text-[11.5px] text-ink-faint transition-colors hover:text-ink"
          >
            {t('new.title')}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {TASKS.map((task) => (
            <button
              key={task.id}
              type="button"
              data-work-task={task.id}
              onClick={() => { state.updateDraft(`${t(task.labelKey)} — ${t(task.bodyKey)}`); }}
              className="flex items-start gap-3 border-b border-hairline py-3.5 text-left transition-colors hover:bg-ink/[0.02] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-selected-ink"
            >
              <span aria-hidden className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-hairline bg-panel text-ink-soft">
                <Icon name={task.icon} size={14} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium leading-[1.35] text-ink">{t(task.labelKey)}</span>
                <span className="mt-0.5 block text-[11.5px] leading-[1.5] text-ink-faint">{t(task.bodyKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
