/**
 * The third way in on the first-run card: reuse a sign-in the computer running
 * Kiki already has (Codex, Kimi Code, Grok — the methods `isOriginalSourceMethod`
 * names).
 *
 * The lane is a button, and nothing is read until it is pressed. The press runs
 * the same read-only check as Settings' "Check this machine" (one per method the
 * server offers; it neither starts the other app nor returns its token), and the
 * lane then states what it found — or that it found nothing, because the person
 * asked. Connecting is a second, separate press, and it carries the account the
 * check showed, so a sign-in that changed in between is refused rather than
 * adopted (`useOriginalOAuthSource`).
 */

import { useCallback, useRef, useState } from 'react';

import { useI18n } from '../../i18n';
import { FeedbackLine } from '../controls';
import { Icon } from '../icons';
import { BLOCK_KEY, ORIGINAL_APP } from '../OriginalSourcePanel';
import { SECONDARY_BUTTON } from '../ui';
import {
  useOriginalOAuthSource,
  type OriginalProvider,
  type OriginalSourceBlock,
  type OriginalSourceController,
} from '../useOriginalOAuthSource';

/** Every method whose original sign-in can be reused, in the order the lane reports them. */
export const ORIGINAL_PROVIDERS: readonly OriginalProvider[] = ['openai-codex', 'kimi-code', 'grok-build'];

export interface LocalSignInCheck {
  readonly phase: 'idle' | 'checking' | 'done';
  /** The methods the last press asked about. */
  readonly checked: readonly OriginalProvider[];
  readonly sources: Readonly<Record<OriginalProvider, OriginalSourceController>>;
  /** Methods the person pressed "use this sign-in" on since the last check. */
  readonly used: ReadonlySet<OriginalProvider>;
  readonly check: () => void;
  readonly cancel: () => void;
  readonly use: (provider: OriginalProvider) => void;
}

/**
 * The check's state lives with the card, not inside the open lane, so the
 * press that opens the lane is also the press that starts the check.
 */
export function useLocalSignInCheck(
  offered: readonly OriginalProvider[] | undefined,
  onConnected: (name: string) => Promise<void> | void,
): LocalSignInCheck {
  const codexConnected = useCallback(() => onConnected(ORIGINAL_APP['openai-codex'].name), [onConnected]);
  const kimiConnected = useCallback(() => onConnected(ORIGINAL_APP['kimi-code'].name), [onConnected]);
  const grokConnected = useCallback(() => onConnected(ORIGINAL_APP['grok-build'].name), [onConnected]);
  const sources = {
    'openai-codex': useOriginalOAuthSource('openai-codex', false, codexConnected),
    'kimi-code': useOriginalOAuthSource('kimi-code', false, kimiConnected),
    'grok-build': useOriginalOAuthSource('grok-build', false, grokConnected),
  };
  const [phase, setPhase] = useState<LocalSignInCheck['phase']>('idle');
  const [checked, setChecked] = useState<readonly OriginalProvider[]>([]);
  const [used, setUsed] = useState<ReadonlySet<OriginalProvider>>(new Set());
  const run = useRef(0);

  const check = () => {
    // The server's list of methods says which sign-ins it can reuse; before
    // that list arrives (or if it failed) every supported one is asked about.
    const targets = offered ?? ORIGINAL_PROVIDERS;
    const id = ++run.current;
    setChecked(targets);
    setUsed(new Set());
    setPhase('checking');
    void Promise.all(targets.map((provider) => sources[provider].probeOriginal())).then(() => {
      if (run.current === id) setPhase('done');
    });
  };
  // A cancelled check leaves its answers unread: the lane goes back to its
  // button, and pressing it again asks again.
  const cancel = () => {
    run.current += 1;
    setPhase('idle');
  };
  const use = (provider: OriginalProvider) => {
    setUsed((current) => new Set(current).add(provider));
    void sources[provider].connectOriginal();
  };

  return { phase, checked, sources, used, check, cancel, use };
}

/**
 * A blocked answer worth a sentence. An app that simply is not signed in here
 * (nothing on disk, or signed out with no account behind it) is not a finding:
 * it counts towards "nothing found", not as a problem with that app.
 */
function reportableBlock(source: OriginalSourceController): OriginalSourceBlock | null {
  const blocked = source.blocked;
  if (source.probe === null || blocked === null || blocked === 'noAccount') return null;
  if (blocked === 'signedOut' && source.probe.account.state !== 'known') return null;
  return blocked;
}

export function LocalSignInLane({ check, remote }: {
  readonly check: LocalSignInCheck;
  /** Phone or browser on another computer's Kiki: say "the computer running Kiki". */
  readonly remote: boolean;
}) {
  const { t } = useI18n();

  if (check.phase === 'checking') {
    return (
      <div data-first-run-local="checking" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-soft" role="status">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="status-dot-busy inline-block h-2 w-2 rounded-full bg-ink-faint" />
          {t('firstRun.lane.local.checking')}
        </span>
        <button type="button" className="text-[12px] text-ink-soft underline-offset-2 hover:text-ink hover:underline pointer-coarse:min-h-11" onClick={check.cancel}>
          {t('common.cancel')}
        </button>
      </div>
    );
  }
  if (check.phase === 'idle') return null;

  const found: OriginalProvider[] = [];
  const blocked: { provider: OriginalProvider; reason: OriginalSourceBlock }[] = [];
  const failures = new Set<string>();
  const connectErrors: { provider: OriginalProvider; text: string }[] = [];
  for (const provider of check.checked) {
    const source = check.sources[provider];
    const feedback = source.feedback;
    if (check.used.has(provider) && feedback !== null) {
      // The connect itself failed (an account that changed, a refused
      // credential): the server's words, under the sign-in it was about.
      connectErrors.push({ provider, text: feedback.text });
      continue;
    }
    if (source.probe !== null && source.blocked === null) {
      found.push(provider);
      continue;
    }
    const reason = reportableBlock(source);
    if (reason !== null) blocked.push({ provider, reason });
    else if (source.probe === null && feedback !== null && feedback.tone === 'error') failures.add(feedback.text);
  }
  const nothing = found.length === 0 && blocked.length === 0 && failures.size === 0 && connectErrors.length === 0;

  return (
    <div data-first-run-local="done" className="space-y-2.5 text-[13px]">
      {found.map((provider) => {
        const source = check.sources[provider];
        const probe = source.probe!;
        const app = ORIGINAL_APP[provider].name;
        return (
          <div key={provider} data-first-run-local-found={provider} className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 text-ink">
              {probe.account.state === 'known'
                ? t('firstRun.lane.local.found', { app, account: probe.account.id })
                : t('firstRun.lane.local.foundNoAccount', { app })}
            </p>
            <button
              type="button"
              data-first-run-local-use={provider}
              className={`${SECONDARY_BUTTON} inline-flex items-center gap-1.5 text-ink pointer-coarse:min-h-11`}
              disabled={source.connecting}
              onClick={() => { check.use(provider); }}
            >
              <Icon name="arrowRight" size={12} />
              {source.connecting ? t('st.source.connecting') : t('firstRun.lane.local.use')}
            </button>
          </div>
        );
      })}
      {connectErrors.map(({ provider, text }) => (
        <div key={provider} data-first-run-local-connect-failed={provider}>
          <FeedbackLine feedback={{ tone: 'error', text }} />
        </div>
      ))}
      {blocked.map(({ provider, reason }) => (
        <p key={provider} data-first-run-local-blocked={reason} className="leading-5 text-ink-soft">
          {t(BLOCK_KEY[reason], { app: ORIGINAL_APP[provider].name })}
        </p>
      ))}
      {[...failures].map((detail) => (
        <div key={detail} data-first-run-local-failed className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <FeedbackLine feedback={{ tone: 'error', text: t(remote ? 'firstRun.lane.localRemote.failed' : 'firstRun.lane.local.failed', { detail }) }} />
          <button type="button" className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`} onClick={check.check}>{t('common.retry')}</button>
        </div>
      ))}
      {nothing ? (
        <p data-first-run-local-none className="text-ink-soft">
          {t(remote ? 'firstRun.lane.localRemote.none' : 'firstRun.lane.local.none')}
        </p>
      ) : null}
    </div>
  );
}
