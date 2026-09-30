import type { ReactNode } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { Toggle } from '../../controls';
import { hookSupport, KIKI_TOOL_GROUPS, kikiDelegationTools, kikiGroupTools, type HookMoment, type KikiContextGroup } from '../../harness/kikiContext';
import { toggleKikiContext, type ProfileDraft } from './profileDraft';

/** The delegation bridge carries many tools; the row names the core ones and counts the rest. */
const DELEGATION_SHOWN = ['kiki_dispatch', 'kiki_wait', 'kiki_result'];

function ToolNames({ names, more = 0 }: { names: readonly string[]; more?: number }) {
  const { tp } = useI18n();
  return <p className="min-w-0 break-words font-mono text-[11px] leading-snug text-ink-faint">
    {names.join(' · ')}{more > 0 ? <span className="font-sans"> · {tp('st.kikiContext.moreTools', more)}</span> : null}
  </p>;
}

/** One capability: the switch row, what the engine gains, and the MCP tools behind it. */
function CapabilityRow({ id, label, hint, tools, moreTools, checked, disabled, onChange, children }: {
  id: string; label: string; hint: string; tools?: readonly string[]; moreTools?: number; checked: boolean; disabled: boolean;
  onChange: (value: boolean) => void; children?: ReactNode;
}) {
  return <li data-kiki-capability={id} data-on={checked ? 'true' : 'false'} className="space-y-1">
    <Toggle layout="row" label={label} checked={checked} disabled={disabled} onChange={onChange} />
    <p className="text-[11.5px] leading-snug text-ink-faint">{hint}</p>
    {tools !== undefined ? <ToolNames names={tools} more={moreTools} /> : null}
    {children}
  </li>;
}

const MOMENT_KEYS: Record<string, I18nKey> = {
  SessionStart: 'st.kikiContext.moment.SessionStart',
  UserPromptSubmit: 'st.kikiContext.moment.UserPromptSubmit',
  PreCompact: 'st.kikiContext.moment.PreCompact',
  Stop: 'st.kikiContext.moment.Stop',
  PreInvocation: 'st.kikiContext.moment.PreInvocation',
};

function Moment({ moment }: { moment: HookMoment }) {
  const { t } = useI18n();
  return <li data-hook-moment={moment.event} data-hook-effect={moment.effect}
    className="col-span-2 grid grid-cols-subgrid items-baseline text-[11.5px] leading-snug">
    <span className="font-mono text-[11px] text-ink-soft">{moment.event}</span>
    <span className={moment.effect === 'prepare' ? 'text-ink-faint' : 'text-ink-soft'}>{t(MOMENT_KEYS[moment.event] ?? 'st.kikiContext.moment.other')}</span>
  </li>;
}

/**
 * "Connect Kiki": what an external main engine may reach back into Kiki for.
 * Delegation keeps its own `allow_kiki_subagents` flag; the tool groups and
 * hooks are one `kiki_context` list. The hooks row says how far hooks reach on
 * this engine, and a field that is written shows whether it is absent or an
 * explicit empty list, so the file never changes shape by surprise.
 */
export function KikiContextField({ draft, baseline, engine, disabled, onChange }: {
  draft: ProfileDraft;
  baseline: ProfileDraft;
  engine: string;
  disabled: boolean;
  onChange: (next: Pick<ProfileDraft, 'allowKikiSubagents' | 'kikiContext'>) => void;
}) {
  const { t, tp } = useI18n();
  const groups = draft.kikiContext ?? [];
  const on = (group: KikiContextGroup) => groups.includes(group);
  const flip = (group: KikiContextGroup, value: boolean) => onChange({
    allowKikiSubagents: draft.allowKikiSubagents,
    kikiContext: toggleKikiContext(draft.kikiContext, group, value, baseline.kikiContext),
  });
  const support = hookSupport(draft.executor);
  const hooksOn = on('hooks');
  return <div data-kiki-context className="space-y-3">
    <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.kikiContext.intro', { engine })}</p>
    <ul className="space-y-3">
      <CapabilityRow id="subagents" label={t('st.profiles.kikiSubagents')} hint={t('st.profiles.kikiSubagentsHint', { engine })}
        tools={DELEGATION_SHOWN} moreTools={kikiDelegationTools().filter((name) => !DELEGATION_SHOWN.includes(name)).length} checked={draft.allowKikiSubagents} disabled={disabled}
        onChange={(value) => onChange({ allowKikiSubagents: value, kikiContext: draft.kikiContext })} />
      {KIKI_TOOL_GROUPS.map((group) => <CapabilityRow key={group} id={group}
        label={t(`st.kikiContext.group.${group}` as I18nKey)} hint={t(`st.kikiContext.hint.${group}` as I18nKey, { engine })}
        tools={kikiGroupTools(group)} checked={on(group)} disabled={disabled} onChange={(value) => flip(group, value)} />)}
    </ul>
    <div className="border-t border-hairline pt-3">
      <ul>
        <CapabilityRow id="hooks" label={t('st.kikiContext.group.hooks')} hint={t('st.kikiContext.hint.hooks', { engine })}
          checked={hooksOn} disabled={disabled || (support.level === 'unsupported' && !hooksOn)} onChange={(value) => flip('hooks', value)}>
          <p data-hook-support={support.level} className="flex flex-wrap items-baseline gap-x-1.5 text-[11.5px] leading-snug">
            <span className="text-ink-soft">{engine}</span>
            <span className={support.level === 'supported' ? 'font-medium text-ink' : support.level === 'untested' ? 'font-medium text-amber-ink' : 'text-ink-faint'}>
              {t(`st.kikiContext.support.${support.level}` as I18nKey)}
            </span>
            {support.level !== 'supported' ? <span className="text-ink-faint">·&nbsp;{t(`st.kikiContext.supportHint.${support.level}` as I18nKey)}</span> : null}
          </p>
          {support.moments.length > 0 ? <ul data-hook-moments aria-label={t('st.kikiContext.momentsLabel')} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pt-0.5">
            {support.moments.map((moment) => <Moment key={moment.event} moment={moment} />)}
          </ul> : null}
        </CapabilityRow>
      </ul>
    </div>
    <div data-kiki-context-field={draft.kikiContext === undefined ? 'absent' : draft.kikiContext.length === 0 ? 'empty' : 'list'}
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-hairline pt-2.5">
      <p className="min-w-0 text-[11.5px] leading-snug text-ink-faint">
        <span className="font-mono text-[11px] text-ink-soft">kiki_context</span>{' '}
        {draft.kikiContext === undefined ? t('st.kikiContext.fieldAbsent')
          : draft.kikiContext.length === 0 ? t('st.kikiContext.fieldEmpty')
            : tp('st.kikiContext.fieldList', draft.kikiContext.length)}
      </p>
      {draft.kikiContext !== undefined ? <button type="button" data-kiki-context-clear disabled={disabled}
        onClick={() => onChange({ allowKikiSubagents: draft.allowKikiSubagents, kikiContext: undefined })}
        className="h-7 shrink-0 rounded-md px-2 text-[12px] text-ink-soft hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50">
        {t('st.kikiContext.clear')}
      </button> : null}
    </div>
    <p className="text-[11.5px] leading-snug text-ink-faint">{t('st.kikiContext.scope')}</p>
  </div>;
}
