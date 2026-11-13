/**
 * ModelConnectCard — what /new shows in the composer's place while the server
 * has nothing to answer with (`needsProviderSetup`: no usable sign-in and an
 * empty model list, both probes answered). It is the server's state, not a
 * one-time step: whenever that is true again, the card is back.
 *
 * One card, three ways in, each finished right here: sign in with an account,
 * enter an API key, or reuse a sign-in already on the computer running Kiki.
 * Opening one folds the other two into a single "use another way" row. The
 * only way out to Settings is the line for a service the key form does not
 * list. A connection that lands refreshes the model queries; the page then
 * puts the composer back in this place and says what is connected.
 *
 * Nothing happens because the card appeared. It reads the server's list of
 * sign-in methods (a catalog, not anyone's credentials) to name them. Checking
 * this computer's sign-ins, signing in, saving a key and installing the skill
 * into another agent all wait for a press.
 *
 * Language is offered here because this is the first text a person reads;
 * appearance is not asked (it follows the system and lives in Settings).
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText, type Locale } from '@kiki/session-core/i18n';

import { useHost } from '../../host';
import { useI18n } from '../../i18n';
import type { HostSkillTarget, OAuthMethodStatus } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { AccountSignIn, OAUTH_METHODS_QUERY_KEY } from '../AccountSignIn';
import { FeedbackLine, type Feedback } from '../controls';
import { Icon } from '../icons';
import { isOriginalSourceMethod, ORIGINAL_APP } from '../OriginalSourcePanel';
import { SearchableSelect } from '../SearchableSelect';
import { CATALOG_PROVIDERS_QUERY_KEY } from '../settings/CatalogImportCard';
import { HOST_SKILL_HOSTS, HostSkillInstallDialog } from '../settings/HostSkillInstallCard';
import { KEEP_SECRET, SecretField, type SecretDraft } from '../settings/SecretField';
import { FORM_SELECT_TRIGGER, SettingsSegmented } from '../settings/SettingsPrimitives';
import { CopyButton } from '../timeline/ContentCopyButton';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import type { OriginalProvider } from '../useOriginalOAuthSource';
import { LocalSignInLane, ORIGINAL_PROVIDERS, useLocalSignInCheck } from './LocalSignInLane';

export type ConnectLane = 'account' | 'key' | 'local';

type Lane = ConnectLane;

/** Settings' add-connection form, for a service or address the key lane does not list. */
const CONNECT_ELSEWHERE_HREF = '/settings/ai?tab=providers#st-card-providers-add';

const LANE_ROW =
  'flex w-full min-h-12 items-center gap-3 px-4 py-2.5 text-left transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selected-ink/40 pointer-coarse:min-h-14';

function listNames(names: readonly string[], locale: Locale): string {
  if (locale === 'zh') return names.join('、');
  return new Intl.ListFormat('en', { style: 'long', type: 'disjunction' }).format(names);
}

export function ModelConnectCard({
  onConnected,
  onHold = () => {},
  surface = 'firstRun',
  initialLane = null,
  configuredProviderIds,
  onOpenCustomForm,
}: {
  /** A way in connected something, named when the lane knows its name. Called before the model queries refresh. */
  readonly onConnected: (name: string | undefined) => void;
  /**
   * A way in saved something that is not checked yet: keep the card here even
   * if the saved models would otherwise bring the composer back. Released by
   * `onConnected`.
   */
  readonly onHold?: () => void;
  /** `settings` omits the first-run title, locale switch and outer composer seat. */
  readonly surface?: 'firstRun' | 'settings';
  readonly initialLane?: ConnectLane | null;
  readonly configuredProviderIds?: ReadonlySet<string>;
  /** Inside Settings, opens the full custom-provider form in place instead of navigating to Settings. */
  readonly onOpenCustomForm?: () => void;
}) {
  const { client, scopeId } = useConnection();
  const host = useHost();
  const { t, locale, setLocale } = useI18n();
  const queryClient = useQueryClient();
  const [lane, setLane] = useState<Lane | null>(initialLane);
  // "This computer" only in the desktop app on its own server; a phone or a
  // browser may be looking at another computer's Kiki.
  const remote = !(host.kind === 'tauri' && scopeId === 'local');

  const methodsQuery = useQuery({
    queryKey: OAUTH_METHODS_QUERY_KEY,
    queryFn: () => client.listOAuthMethods(),
    staleTime: 10_000,
  });
  const listed = methodsQuery.data;
  const methods = listed ?? [];
  const offeredOriginal = useMemo<readonly OriginalProvider[] | undefined>(
    () => (listed === undefined
      ? undefined
      : ORIGINAL_PROVIDERS.filter((provider) => listed.some((method) => isOriginalSourceMethod(method) && method.id === provider))),
    [listed],
  );

  const connected = useCallback(async (name: string | undefined) => {
    onConnected(name);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['providers'] }),
      queryClient.invalidateQueries({ queryKey: ['models'] }),
      queryClient.invalidateQueries({ queryKey: ['auth'] }),
      queryClient.invalidateQueries({ queryKey: ['config'] }),
      queryClient.invalidateQueries({ queryKey: OAUTH_METHODS_QUERY_KEY }),
    ]);
  }, [onConnected, queryClient]);
  const localCheck = useLocalSignInCheck(offeredOriginal, connected);

  const accountLine = methods.length > 0
    ? t('firstRun.lane.account.line', { names: listNames(methods.map((method) => method.label), locale) })
    : undefined;
  const localLine = t('firstRun.lane.local.line', {
    names: listNames((offeredOriginal ?? ORIGINAL_PROVIDERS).map((provider) => ORIGINAL_APP[provider].name), locale),
  });
  // A server that offers no reusable sign-in has nothing for that lane to check.
  const offersLocal = offeredOriginal === undefined || offeredOriginal.length > 0;
  const lanes: readonly { id: Lane; title: string; line: string | undefined }[] = [
    { id: 'account', title: t('firstRun.lane.account'), line: accountLine },
    { id: 'key', title: t('firstRun.lane.key'), line: t('firstRun.lane.key.line') },
    ...(offersLocal
      ? [{ id: 'local' as const, title: t(remote ? 'firstRun.lane.localRemote' : 'firstRun.lane.local'), line: localLine }]
      : []),
  ];

  // The third lane's row is the check itself: the press that opens it is the
  // press that asks, and nothing was read before it.
  const openLane = (next: Lane) => {
    setLane(next);
    if (next === 'local') localCheck.check();
  };
  const current = lanes.find((candidate) => candidate.id === lane);

  const inSettings = surface === 'settings';
  const card = (
    <section
      data-first-run-card={lane ?? 'lanes'}
      aria-labelledby={inSettings ? undefined : 'first-run-card-title'}
      aria-label={inSettings ? t('st.connections.addTitle') : undefined}
      className={inSettings
        ? 'w-full overflow-hidden rounded-lg border border-hairline bg-panel text-left'
        : 'composer-card mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)] overflow-hidden rounded-[18px] bg-panel text-left'}
    >
      {inSettings ? null : (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-3">
          <h2 id="first-run-card-title" className="min-w-0 font-display text-[16px] font-semibold tracking-tight text-ink">
            {t('firstRun.card.title')}
          </h2>
          <SettingsSegmented<Locale>
            ariaLabel={t('st.language.title')}
            value={locale}
            onChange={setLocale}
            dataAttr="data-first-run-locale"
            choices={[{ value: 'en', label: 'English' }, { value: 'zh', label: '中文' }]}
          />
        </header>
      )}

      <div className={`divide-y divide-hairline ${inSettings ? '' : 'border-t border-hairline'}`}>
        {current === undefined ? (
          lanes.map((candidate) => (
            <button key={candidate.id} type="button" data-first-run-lane={candidate.id} className={LANE_ROW} onClick={() => { openLane(candidate.id); }}>
              <LaneLabel title={candidate.title} line={candidate.line} />
              <Icon name="chevron" size={14} className="shrink-0 text-ink-faint" />
            </button>
          ))
        ) : (
          <>
            <div data-first-run-open-lane={current.id}>
              {current.id === 'local' ? (
                // Pressing the open lane's own row asks again.
                <button type="button" data-first-run-lane="local" className={LANE_ROW} onClick={localCheck.check}>
                  <LaneLabel title={current.title} line={current.line} />
                  <Icon name="refresh" size={14} className="shrink-0 text-ink-faint" />
                </button>
              ) : (
                <div className="px-4 pt-3 pb-1">
                  <LaneLabel title={current.title} line={current.line} />
                </div>
              )}
              <div className="px-4 pt-1 pb-4">
                {current.id === 'account' ? <AccountLane methods={listed} configuredProviderIds={configuredProviderIds} onConnected={connected} /> : null}
                {current.id === 'key' ? <KeyLane onConnected={connected} onHold={onHold} onOpenCustomForm={onOpenCustomForm} /> : null}
                {current.id === 'local' ? <LocalSignInLane check={localCheck} remote={remote} /> : null}
              </div>
            </div>
            <button
              type="button"
              data-first-run-switch
              className={LANE_ROW}
              onClick={() => {
                if (lane === 'local') localCheck.cancel();
                setLane(null);
              }}
            >
              <span className="min-w-0 flex-1 text-[13px] text-ink-soft">{t('firstRun.lane.switch')}</span>
              <Icon name="chevron" size={14} className="shrink-0 text-ink-faint" />
            </button>
          </>
        )}
      </div>

      {inSettings ? null : <AgentSetupLine />}
    </section>
  );

  if (inSettings) return card;

  return (
    <div className="px-3 pb-3 sm:px-6 sm:pb-5" data-first-run-card-seat>
      {card}
    </div>
  );
}

function LaneLabel({ title, line }: { readonly title: string; readonly line: string | undefined }) {
  return (
    <span className="block min-w-0 flex-1">
      <span className="block text-[14px] font-medium text-ink">{title}</span>
      {line === undefined ? null : <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-soft">{line}</span>}
    </span>
  );
}

/**
 * The server's account sign-ins: Settings' own list, without its per-account
 * "use this machine's sign-in" panels, which are this card's third way in.
 * The list reports a finished sign-in without saying which one, so the line
 * after connecting names the method that turned signed-in since the lane
 * opened.
 */
function AccountLane({ methods, configuredProviderIds, onConnected }: {
  readonly methods: readonly OAuthMethodStatus[] | undefined;
  readonly configuredProviderIds?: ReadonlySet<string>;
  readonly onConnected: (name: string | undefined) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const signedInBefore = useRef<ReadonlySet<string> | null>(null);
  if (signedInBefore.current === null && methods !== undefined) {
    signedInBefore.current = new Set(methods.filter((method) => method.signed_in).map((method) => method.id));
  }
  // The sign-in flow re-reads the method list before calling this.
  const signedIn = useCallback(async () => {
    const latest = queryClient.getQueryData<readonly OAuthMethodStatus[]>(OAUTH_METHODS_QUERY_KEY) ?? [];
    const fresh = latest.find((method) => method.signed_in && signedInBefore.current?.has(method.id) !== true);
    await onConnected(fresh?.label);
  }, [onConnected, queryClient]);
  return <AccountSignIn compact originalSource={false} configuredProviderIds={configuredProviderIds} onChanged={signedIn} />;
}

/**
 * A service from the models.dev directory, a key, and Connect. The directory
 * import writes the service's address and model list with the key, and the
 * server picks the default model when none is set yet. A service the directory
 * does not carry, a local server or a custom address goes to Settings' full
 * form.
 *
 * Nothing is called connected before it answered. Connect saves the service,
 * then sends the same one small real request as Settings' "Test connection";
 * the card holds its place meanwhile (`onHold`), even though the saved models
 * would otherwise put the composer back. A key that fails the check is not
 * left behind: a connection this card created is removed again, so the card
 * is back where it started and another key can be tried; if the removal
 * fails, the card says so. A connection to the same service that existed
 * before the press (added elsewhere meanwhile) is never removed, though the
 * import has put the failed key on it.
 */
function KeyLane({ onConnected, onHold, onOpenCustomForm }: {
  readonly onConnected: (name: string | undefined) => Promise<void>;
  readonly onHold: () => void;
  readonly onOpenCustomForm?: () => void;
}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const navigate = useNavigate();
  const catalog = useQuery({
    queryKey: CATALOG_PROVIDERS_QUERY_KEY,
    queryFn: () => client.listCatalogProviders(),
    staleTime: 10 * 60_000,
  });
  // Only entries that import with a key alone; one that needs an address is
  // the full form's job.
  const services = useMemo(
    () => (catalog.data?.items ?? [])
      .filter((item) => !item.rejected && !item.needs_base_url)
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    [catalog.data],
  );
  const [serviceId, setServiceId] = useState('');
  const [key, setKey] = useState<SecretDraft>(KEEP_SECRET);
  const [step, setStep] = useState<'idle' | 'saving' | 'checking'>('idle');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [leftBehind, setLeftBehind] = useState<Feedback>(null);
  // Connections this card added and could not take back: a later press that
  // fails again still removes them instead of treating them as the person's.
  const leftByCard = useRef(new Set<string>());
  const service = services.find((item) => item.id === serviceId);

  const connect = async () => {
    if (service === undefined) return;
    setStep('saving');
    setFeedback(null);
    setLeftBehind(null);
    onHold();
    let created: string | undefined;
    try {
      const existing = await client.listProviders();
      const apiKey = key.mode === 'set' ? key.value.trim() : '';
      const imported = await client.importCatalogProvider({ catalog_id: service.id, api_key: apiKey === '' ? undefined : apiKey });
      const providerId = imported.provider.id;
      if (leftByCard.current.has(providerId) || !existing.items.some((provider) => provider.id === providerId)) created = providerId;
      setStep('checking');
      let detail: string | undefined;
      let checkedModel: string | undefined;
      try {
        const result = await client.testProviderConnection(providerId);
        checkedModel = result.model_id;
        if (!result.ok) {
          detail = [result.error, result.error_code, result.http_status === undefined ? undefined : `HTTP ${result.http_status}`]
            .find((part) => part !== undefined && part.trim() !== '') ?? t('common.unknownError');
        }
      } catch (error) {
        detail = errorText(locale, error);
      }
      if (detail !== undefined) {
        setFeedback({ tone: 'error', text: t('firstRun.key.invalid', { detail }) });
        if (created !== undefined) {
          try {
            await client.deleteProviderEntity(created);
            leftByCard.current.delete(created);
          } catch (error) {
            // Saved, not working, and could not be taken back: say so, so it
            // is never a connection the person does not know about.
            leftByCard.current.add(created);
            setLeftBehind({ tone: 'error', text: t('firstRun.key.leftBehind', { detail: errorText(locale, error) }) });
          }
        }
        return;
      }
      leftByCard.current.delete(providerId);
      if (checkedModel !== undefined) {
        // The connection works either way; a default left pointing at nothing
        // still shows as such on the composer's model chip.
        await repairDanglingDefault(checkedModel).catch(() => undefined);
      }
      await onConnected(service.name);
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.catalog.importFailed', { detail: errorText(locale, error) }) });
    } finally {
      setStep('idle');
    }
  };

  /**
   * The server picks a default model only while none is set. A connection
   * removed after a failed check may have left that pick pointing at a model
   * that no longer exists, and no later import replaces it, so new
   * conversations would start on nothing. Only that case is repaired, with
   * the model the check has just shown to answer.
   */
  const repairDanglingDefault = async (modelId: string) => {
    const [config, catalogModels] = await Promise.all([client.getConfig(), client.listModels()]);
    const current = config.default_model;
    if (current === undefined || current === '' || catalogModels.items.some((model) => model.id === current)) return;
    await client.setDefaultModel(modelId);
  };

  let body: ReactNode;
  if (catalog.isPending) {
    body = <p className="text-[13px] text-ink-faint">{t('st.catalog.loading')}</p>;
  } else if (catalog.isError) {
    body = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FeedbackLine feedback={{ tone: 'error', text: t('st.catalog.loadFailed', { detail: errorText(locale, catalog.error) }) }} />
        <button type="button" className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`} onClick={() => { void catalog.refetch(); }}>
          {t('common.retry')}
        </button>
      </div>
    );
  } else {
    body = (
      <form
        data-first-run-key-form
        noValidate
        className="space-y-3"
        onSubmit={(event) => { event.preventDefault(); void connect(); }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <span id="first-run-key-service" className="block text-[13px] font-medium text-ink">{t('firstRun.key.service')}</span>
            <SearchableSelect
              id="first-run-key-service-select"
              ariaLabel={t('firstRun.key.service')}
              value={serviceId}
              onChange={(next) => { setServiceId(next); setFeedback(null); }}
              options={services.map((item) => ({ value: item.id, label: item.name, hint: tp('st.catalog.models', item.models.length), keywords: item.id }))}
              searchPlaceholder={t('st.catalog.searchPlaceholder')}
              noMatchText={(query) => t('st.catalog.noMatch', { query })}
              triggerLabel={service?.name ?? t('firstRun.key.choose')}
              buttonClassName={FORM_SELECT_TRIGGER}
            />
          </div>
          <SecretField
            label={t('firstRun.key.key')}
            source="none"
            draft={key}
            onChange={setKey}
            placeholder={t('st.providers.keyNew')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" data-first-run-key-connect className={`${PRIMARY_BUTTON} pointer-coarse:min-h-11`} disabled={service === undefined || step !== 'idle'}>
            {step === 'saving' ? t('st.catalog.importing') : t('firstRun.key.connect')}
          </button>
          {step === 'checking' ? (
            <span role="status" data-first-run-key-checking className="text-[12.5px] text-ink-soft">{t('firstRun.key.checking')}</span>
          ) : null}
        </div>
        <div data-first-run-key-failed={feedback === null ? undefined : ''}>
          <FeedbackLine feedback={feedback} />
        </div>
        {leftBehind === null ? null : <div data-first-run-key-left-behind><FeedbackLine feedback={leftBehind} /></div>}
      </form>
    );
  }

  return (
    <div className="space-y-3" data-first-run-key>
      {body}
      <p className="text-[12.5px] text-ink-soft">
        {t('firstRun.key.other')}
        <span aria-hidden className="px-1.5">·</span>
        <button
          type="button"
          data-first-run-key-elsewhere
          className="rounded-sm text-ink underline decoration-hairline-strong underline-offset-[3px] hover:decoration-ink-soft focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
          onClick={() => {
            if (onOpenCustomForm !== undefined) onOpenCustomForm();
            else void navigate(CONNECT_ELSEWHERE_HREF);
          }}
        >
          {t('firstRun.key.otherAction')}
        </button>
      </p>
    </div>
  );
}

/**
 * The quiet last line: let an agent the person already uses set Kiki up. It
 * installs the `kiki-ops` skill into that agent's folder — one press to pick
 * the agent, a preview, a second press to write — and then hands over the one
 * line to paste there. Nothing is written before that second press.
 */
function AgentSetupLine() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [installHost, setInstallHost] = useState<HostSkillTarget | null>(null);
  const [installedHost, setInstalledHost] = useState<HostSkillTarget | null>(null);
  const hostName = (id: HostSkillTarget) => t(HOST_SKILL_HOSTS.find((candidate) => candidate.id === id)!.name);
  const pasteLine = t('firstRun.agent.pasteLine');

  return (
    <div className="border-t border-hairline px-4 py-3" data-first-run-agent>
      <button
        type="button"
        data-first-run-agent-toggle
        aria-expanded={open}
        className="rounded-sm text-left text-[12.5px] text-ink-soft underline-offset-[3px] hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-11"
        onClick={() => { setOpen((value) => !value); }}
      >
        {t('firstRun.agent.line')}
      </button>
      {open ? (
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('firstRun.agent.line')}>
          {HOST_SKILL_HOSTS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              data-first-run-agent-host={candidate.id}
              aria-label={t('firstRun.agent.installFor', { host: t(candidate.name) })}
              className={`${SECONDARY_BUTTON} pointer-coarse:min-h-11`}
              onClick={() => { setInstallHost(candidate.id); }}
            >
              {t(candidate.name)}
            </button>
          ))}
        </div>
      ) : null}
      {installedHost !== null ? (
        <div className="mt-3" data-first-run-agent-installed={installedHost}>
          <p className="text-[12px] leading-relaxed text-ink-soft">
            {t('firstRun.agent.installed', { host: hostName(installedHost) })}
          </p>
          <div className="mt-1.5 inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-hairline bg-paper pl-2.5">
            <code className="truncate font-mono text-[12px] text-ink" title={pasteLine}>{pasteLine}</code>
            <CopyButton text={pasteLine} label={t('firstRun.agent.copy')} />
          </div>
        </div>
      ) : null}
      {installHost !== null ? (
        <HostSkillInstallDialog
          host={installHost}
          skill="kiki-ops"
          hostName={hostName(installHost)}
          onClose={() => { setInstallHost(null); }}
          onInstalled={() => {
            setInstalledHost(installHost);
            setInstallHost(null);
          }}
        />
      ) : null}
    </div>
  );
}
