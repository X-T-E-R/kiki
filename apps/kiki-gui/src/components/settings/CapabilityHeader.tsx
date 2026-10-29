/**
 * The head of one capability section (browser, computer, a plugin): the name,
 * one status sentence that says what the Agent can do right now, the master
 * 启用 switch, and — only while the capability is on — the 新会话默认开启
 * switch under it. An optional primary action (安装执行器) sits next to the
 * verdict, so a missing capability offers exactly one next move.
 *
 * Everything is wired by the owner; this component owns the layout and the
 * click model only: the switches are the only controls on the header, and the
 * sentence never carries an action inside its text.
 */

import type { ReactNode } from 'react';

import type { ControlVerdictTone } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import { SaveStatus } from '../controls';
import { ControlVerdictLine } from './browserControl/ControlVerdict';

function HeaderSwitch({ id, attr, label, checked, disabled, onChange }: {
  readonly id: string;
  readonly attr: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <label htmlFor={id} className={`text-[13px] ${disabled ? 'text-ink-faint' : 'cursor-pointer text-ink'}`}>{label}</label>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        {...{ [attr]: '' }}
        onClick={() => { onChange(!checked); }}
        className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors duration-[var(--kiki-motion-quick)] ${
          checked ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
        } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
            checked ? 'translate-x-[16px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
          }`}
        />
      </button>
    </span>
  );
}

export function CapabilityHeader({
  title,
  verdict,
  enabled,
  onEnabledChange,
  enabledLockedReason,
  saving,
  saved,
  defaultOn,
  onDefaultOnChange,
  defaultOnSaving,
  primaryAction,
  attrs,
  children,
}: {
  readonly title: string;
  readonly verdict: {
    readonly kind: string;
    readonly tone: ControlVerdictTone;
    readonly text: string;
    readonly detail?: string;
    readonly action?: ReactNode;
  };
  readonly enabled: boolean;
  readonly onEnabledChange: (next: boolean) => void;
  /** Why the master switch is inert (the host locked it); shown next to it. */
  readonly enabledLockedReason?: string;
  readonly saving?: boolean;
  readonly saved?: boolean;
  /** Shown only while `enabled`; omit when the capability has no new-session default. */
  readonly defaultOn?: {
    readonly checked: boolean;
    /** A reason the default cannot be changed here (host lock, unresolved state). */
    readonly locked?: boolean;
  };
  readonly onDefaultOnChange?: (next: boolean) => void;
  readonly defaultOnSaving?: boolean;
  /** The one next move this state needs, e.g. 安装执行器. */
  readonly primaryAction?: ReactNode;
  readonly attrs: {
    readonly enabled: `data-${string}`;
    readonly verdict: `data-${string}`;
    readonly enabledSwitch: `data-${string}`;
    readonly defaultOn?: `data-${string}`;
  };
  readonly children?: ReactNode;
}) {
  const { t } = useI18n();
  const enabledDisabled = saving === true || enabledLockedReason !== undefined;
  const defaultOnDisabled = defaultOn?.locked === true || defaultOnSaving === true;
  return (
    <div className="space-y-3" {...{ [attrs.enabled]: enabled ? 'true' : 'false' }}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[15px] font-medium text-ink" data-capability-name>{title}</span>
          <ControlVerdictLine
            attr={attrs.verdict}
            kind={verdict.kind}
            tone={verdict.tone}
            text={verdict.text}
            detail={verdict.detail}
            action={primaryAction ?? verdict.action}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SaveStatus saving={saving === true} saved={saved === true} />
          {enabledLockedReason === undefined ? null : (
            <span className="text-[12px] text-ink-faint" data-capability-locked-reason>{enabledLockedReason}</span>
          )}
          <HeaderSwitch
            id={`${attrs.enabledSwitch.replace(/^data-/, '')}-switch`}
            attr={attrs.enabledSwitch}
            label={t('cap.switch.enable')}
            checked={enabled}
            disabled={enabledDisabled}
            onChange={onEnabledChange}
          />
        </div>
      </div>
      {children}
      {enabled && defaultOn !== undefined && onDefaultOnChange !== undefined ? (
        <div className="flex items-center gap-2" {...(attrs.defaultOn === undefined ? {} : { [attrs.defaultOn]: '' })}>
          <HeaderSwitch
            id={`${attrs.enabledSwitch.replace(/^data-/, '')}-default-on`}
            attr="data-capability-default-switch"
            label={t('cap.switch.defaultOn')}
            checked={defaultOn.checked}
            disabled={defaultOnDisabled}
            onChange={onDefaultOnChange}
          />
          <SaveStatus saving={defaultOnSaving === true} saved={false} />
        </div>
      ) : null}
    </div>
  );
}
