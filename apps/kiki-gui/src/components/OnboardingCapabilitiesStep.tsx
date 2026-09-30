/**
 * The onboarding capabilities page: what else Kiki can do, grouped by what
 * the user is after, one row per capability with the one or two actions that
 * set it up. Nothing here is required — the wizard's Start finishes without
 * touching a row.
 *
 * Three kinds of action:
 * - `open` leaves the wizard for the settings card (or page) that configures
 *   the capability, through the ordinary `/settings/<section>#st-card-*` deep
 *   link (SettingsPage resolves the tab and flashes the card).
 * - `ask` hands a multi-step setup to Kiki: the wizard creates a session and
 *   pre-fills a `/kiki-ops` request in its composer; nothing is sent.
 * - `install` opens the settings page's own preview → confirm dialog for the
 *   kiki-as-subagent skill, so the target path and any overwrite are shown
 *   before a byte is written.
 */

import { useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import type { HostSkillTarget } from '../lib/client';
import { FeedbackLine, type Feedback } from './controls';
import { Icon } from './icons';
import { HOST_SKILL_HOSTS, HostSkillInstallDialog } from './settings/HostSkillInstallCard';
import { SECONDARY_BUTTON } from './ui';

export type CapabilityAction =
  | { readonly kind: 'open'; readonly href: string; readonly labelKey: I18nKey }
  | { readonly kind: 'ask'; readonly promptKey: I18nKey }
  | { readonly kind: 'install'; readonly hosts: readonly HostSkillTarget[] };

export interface OnboardingCapability {
  readonly id: string;
  readonly nameKey: I18nKey;
  readonly lineKey: I18nKey;
  /** Tool or product names, shown verbatim in mono: machine values stay English. */
  readonly names?: string;
  readonly actions: readonly CapabilityAction[];
}

export interface OnboardingCapabilityGroup {
  readonly id: string;
  readonly titleKey: I18nKey;
  readonly items: readonly OnboardingCapability[];
}

/**
 * Only capabilities the product ships today; each target is a real settings
 * card id (SETTINGS_SEARCH_SPEC) or app route.
 */
export const ONBOARDING_CAPABILITIES: readonly OnboardingCapabilityGroup[] = [
  {
    id: 'find',
    titleKey: 'onboarding.caps.group.find',
    items: [
      {
        id: 'search',
        nameKey: 'onboarding.caps.search.name',
        lineKey: 'onboarding.caps.search.line',
        names: 'WebSearch · FetchURL · HistorySearch',
        actions: [
          { kind: 'ask', promptKey: 'onboarding.caps.search.prompt' },
          { kind: 'open', href: '/settings/search#st-card-search-providers', labelKey: 'onboarding.caps.openSettings' },
        ],
      },
      {
        id: 'memory',
        nameKey: 'onboarding.caps.memory.name',
        lineKey: 'onboarding.caps.memory.line',
        names: 'MemoryRead · MemoryWrite',
        actions: [{ kind: 'open', href: '/settings/memory#st-card-memory', labelKey: 'onboarding.caps.openSettings' }],
      },
    ],
  },
  {
    id: 'reach',
    titleKey: 'onboarding.caps.group.reach',
    items: [
      {
        id: 'ssh',
        nameKey: 'onboarding.caps.ssh.name',
        lineKey: 'onboarding.caps.ssh.line',
        actions: [
          { kind: 'ask', promptKey: 'onboarding.caps.ssh.prompt' },
          { kind: 'open', href: '/settings/ssh#st-card-ssh-hosts', labelKey: 'onboarding.caps.openSettings' },
        ],
      },
      {
        id: 'engines',
        nameKey: 'onboarding.caps.engines.name',
        lineKey: 'onboarding.caps.engines.line',
        names: 'Claude Code · Codex · Antigravity · Grok Build',
        actions: [{ kind: 'open', href: '/settings/ai#st-card-engines', labelKey: 'onboarding.caps.openSettings' }],
      },
      {
        id: 'extensions',
        nameKey: 'onboarding.caps.extensions.name',
        lineKey: 'onboarding.caps.extensions.line',
        actions: [
          { kind: 'ask', promptKey: 'onboarding.caps.extensions.prompt' },
          { kind: 'open', href: '/settings/plugins#st-card-plugins', labelKey: 'onboarding.caps.openSettings' },
        ],
      },
      {
        id: 'host-skill',
        nameKey: 'onboarding.caps.hostSkill.name',
        lineKey: 'onboarding.caps.hostSkill.line',
        names: 'kiki-as-subagent',
        actions: [{ kind: 'install', hosts: ['claude', 'codex', 'grok'] }],
      },
    ],
  },
  {
    id: 'run',
    titleKey: 'onboarding.caps.group.run',
    items: [
      {
        id: 'cron',
        nameKey: 'onboarding.caps.cron.name',
        lineKey: 'onboarding.caps.cron.line',
        actions: [
          { kind: 'ask', promptKey: 'onboarding.caps.cron.prompt' },
          { kind: 'open', href: '/cron', labelKey: 'onboarding.caps.openCron' },
        ],
      },
      {
        id: 'board',
        nameKey: 'onboarding.caps.board.name',
        lineKey: 'onboarding.caps.board.line',
        actions: [{ kind: 'open', href: '/board', labelKey: 'onboarding.caps.openBoard' }],
      },
      {
        id: 'bots',
        nameKey: 'onboarding.caps.bots.name',
        lineKey: 'onboarding.caps.bots.line',
        actions: [
          { kind: 'ask', promptKey: 'onboarding.caps.bots.prompt' },
          { kind: 'open', href: '/personas', labelKey: 'onboarding.caps.openPersonas' },
        ],
      },
    ],
  },
];

const ROW_ACTION =
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';

function CapabilityRow({ item, askingId, onOpen, onAsk, onInstall, feedback }: {
  readonly item: OnboardingCapability;
  /** The row whose "ask Kiki" session is being created; every ask waits on it. */
  readonly askingId: string | null;
  readonly onOpen: (href: string) => void;
  readonly onAsk: (id: string, prompt: string) => void;
  readonly onInstall: (host: HostSkillTarget) => void;
  readonly feedback: Feedback;
}) {
  const { t } = useI18n();
  const nameId = `onboarding-cap-${item.id}`;
  return (
    <li
      data-onboarding-cap={item.id}
      aria-labelledby={nameId}
      className="grid gap-x-4 gap-y-2 border-t border-hairline py-2 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span id={nameId} className="text-[13px] font-medium text-ink">{t(item.nameKey)}</span>
          {item.names !== undefined ? (
            <span className="font-mono text-[11px] text-ink-faint">{item.names}</span>
          ) : null}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">{t(item.lineKey)}</p>
        {feedback !== null ? <div className="mt-1"><FeedbackLine feedback={feedback} /></div> : null}
      </div>
      {/* Two aligned columns on wide screens — "ask Kiki", then the page link —
          so the same kind of action sits at the same x down the list. */}
      <div className={item.actions.some((action) => action.kind === 'install')
        ? 'flex flex-wrap items-center gap-1.5 sm:justify-end'
        : 'flex flex-wrap items-center gap-1.5 sm:grid sm:grid-cols-[9rem_7.5rem] sm:[&>:first-child]:justify-self-end'}>
        {item.actions.some((action) => action.kind === 'ask') || item.actions.some((action) => action.kind === 'install')
          ? null
          : <span aria-hidden className="hidden sm:block" />}
        {item.actions.map((action) => {
          if (action.kind === 'ask') {
            const busy = askingId === item.id;
            return (
              <button
                key="ask"
                type="button"
                data-cap-ask={item.id}
                disabled={askingId !== null}
                aria-describedby={nameId}
                onClick={() => { onAsk(item.id, t(action.promptKey)); }}
                className={`${ROW_ACTION} border border-hairline bg-paper text-ink hover:border-hairline-strong`}
              >
                {busy ? t('onboarding.caps.asking') : t('onboarding.caps.ask')}
              </button>
            );
          }
          if (action.kind === 'open') {
            return (
              <button
                key={action.href}
                type="button"
                data-cap-open={action.href}
                aria-describedby={nameId}
                onClick={() => { onOpen(action.href); }}
                className={`${ROW_ACTION} text-ink-soft hover:bg-ink/[0.04] hover:text-ink`}
              >
                {t(action.labelKey)}
                <Icon name="arrowUpRight" size={12} />
              </button>
            );
          }
          return action.hosts.map((host) => {
            const spec = HOST_SKILL_HOSTS.find((candidate) => candidate.id === host)!;
            return (
              <button
                key={host}
                type="button"
                data-cap-install={host}
                aria-label={t('st.hostSkill.previewNamed', { host: t(spec.name) })}
                onClick={() => { onInstall(host); }}
                className={`${SECONDARY_BUTTON} h-7 py-0`}
              >
                {t(spec.name)}
              </button>
            );
          });
        })}
      </div>
    </li>
  );
}

/**
 * The page itself. `onAsk` resolves when the session exists (the wizard has
 * closed by then) or rejects with a readable message for the row.
 */
export function OnboardingCapabilitiesStep({ onOpen, onAsk }: {
  readonly onOpen: (href: string) => void;
  readonly onAsk: (prompt: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [askingId, setAskingId] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ readonly id: string; readonly text: string } | null>(null);
  const [installing, setInstalling] = useState<HostSkillTarget | null>(null);
  const [installed, setInstalled] = useState<Partial<Record<HostSkillTarget, string>>>({});

  const ask = (id: string, prompt: string) => {
    setAskingId(id);
    setFailed(null);
    onAsk(prompt).catch((error: unknown) => {
      setAskingId(null);
      setFailed({ id, text: error instanceof Error ? error.message : String(error) });
    });
  };

  const installedHosts = Object.keys(installed) as HostSkillTarget[];
  const feedbackFor = (id: string): Feedback => {
    if (failed?.id === id) return { tone: 'error', text: t('onboarding.caps.askFailed', { detail: failed.text }) };
    if (id === 'host-skill' && installedHosts.length > 0) {
      const names = installedHosts.map((host) => t(HOST_SKILL_HOSTS.find((spec) => spec.id === host)!.name)).join(', ');
      return { tone: 'success', text: t('onboarding.caps.hostSkill.installed', { hosts: names }) };
    }
    return null;
  };

  return (
    <div className="mt-3" data-onboarding-capabilities>
      <p className="text-[12px] leading-relaxed text-ink-soft">{t('onboarding.caps.body')}</p>
      <div className="mt-4 space-y-4">
        {ONBOARDING_CAPABILITIES.map((group) => (
          <section key={group.id} aria-labelledby={`onboarding-caps-${group.id}`} data-onboarding-cap-group={group.id}>
            <h4 id={`onboarding-caps-${group.id}`} className="text-[12px] font-medium text-section-ink">
              {t(group.titleKey)}
            </h4>
            <ul className="mt-1">
              {group.items.map((item) => (
                <CapabilityRow
                  key={item.id}
                  item={item}
                  askingId={askingId}
                  onOpen={onOpen}
                  onAsk={ask}
                  onInstall={setInstalling}
                  feedback={feedbackFor(item.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {installing !== null ? (
        <HostSkillInstallDialog
          host={installing}
          hostName={t(HOST_SKILL_HOSTS.find((spec) => spec.id === installing)!.name)}
          onClose={() => { setInstalling(null); }}
          onInstalled={(result) => {
            setInstalled((current) => ({ ...current, [installing]: result.path }));
            setInstalling(null);
          }}
        />
      ) : null}
    </div>
  );
}
