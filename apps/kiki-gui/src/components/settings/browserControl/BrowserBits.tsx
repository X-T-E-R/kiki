/**
 * Small pieces of the browser slice: the connection state mark (dot + word), the
 * named conditions of the ecosystems this version does not drive yet, and the
 * folded run facts — the status fields, the connected daemon's own target list,
 * and the managed backend's capability catalogue.
 *
 * The words are the control service's own (`app/browser/browser.ts`
 * `BrowserStatus.state`). Only three of them carry a colour: a failure is
 * danger, an unconfirmed stop is caution, everything else is normal — a
 * connection that is not running is the usual case, not a problem.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import { useConnection } from '../../../state/connection';
import { Tag } from '../../capabilities/primitives';
import { InlineError, Toggle } from '../../controls';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { AdvancedDetails } from '../fields';
import {
  AGENT_BROWSER_MARKERS, AGENT_BROWSER_VERSION, LIVE_STATES, browserApi, browserKeys, whenText, type BrowserStatus,
} from '../../../lib/browserRest';

const STATE_KEYS: Readonly<Record<string, I18nKey>> = {  idle: 'st.browser.state.idle',
  connecting: 'st.browser.state.connecting',
  ready: 'st.browser.state.ready',
  running: 'st.browser.state.running',
  stopping: 'st.browser.state.stopping',
  disconnected: 'st.browser.state.disconnected',
  failed: 'st.browser.state.failed',
  unconfirmed: 'st.browser.state.unconfirmed',
  /** Not a service state: the connection is switched off in its configuration. */
  disabled: 'st.browser.state.disabled',
};

export function browserStateLabel(t: ReturnType<typeof useI18n>['t'], state: string): string {
  const key = STATE_KEYS[state];
  return key === undefined ? state : t(key);
}

function toneOf(state: string): string {
  if (state === 'failed') return 'text-danger';
  if (state === 'unconfirmed') return 'text-amber-ink';
  if (state === 'ready' || state === 'running') return 'text-ink-soft';
  return 'text-ink-faint';
}

function dotOf(state: string): string {
  if (state === 'failed') return 'bg-danger';
  if (state === 'unconfirmed') return 'bg-amber-rule';
  if (state === 'ready' || state === 'running') return 'bg-ink-soft';
  if (state === 'connecting' || state === 'stopping') return 'status-dot-busy bg-ink-soft';
  return 'bg-hairline-strong';
}

export function BrowserStateMark({ state, compact = false }: {
  readonly state: string;
  /** Keeps the word for assistive tech only, on rows too narrow to hold it. */
  readonly compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <span data-browser-state={state} className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${toneOf(state)}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dotOf(state)}`} />
      <span className={compact ? 'sr-only' : ''}>{browserStateLabel(t, state)}</span>
    </span>
  );
}

/** The ecosystems the design keeps on the route but this version does not drive. */
const OTHER_ECOSYSTEMS = [
  { id: 'webbridge', name: 'st.browser.other.webbridge.name', condition: 'st.browser.other.webbridge' },
  { id: 'cloud', name: 'st.browser.other.cloud.name', condition: 'st.browser.other.cloud' },
  { id: 'codex', name: 'st.browser.other.codex.name', condition: 'st.browser.other.codex' },
  { id: 'executors', name: 'st.browser.other.executors.name', condition: 'st.browser.other.executors' },
] as const satisfies readonly { id: string; name: I18nKey; condition: I18nKey }[];

/**
 * Named, not clickable: each line is the real condition for that route, and the
 * page says outright that it is not wired. An inert button would claim a
 * capability the server does not have.
 */
export function OtherBrowserEcosystems() {
  const { t } = useI18n();
  return (
    <AdvancedDetails summary={t('st.browser.otherTitle')} data-browser-other>
      <p className="max-w-[62ch]">{t('st.browser.otherHint')}</p>
      <dl className="space-y-2">
        {OTHER_ECOSYSTEMS.map((row) => (
          <div key={row.id} data-browser-other-row={row.id}>
            <dt className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-medium text-ink">{t(row.name)}</span>
              {row.id === 'webbridge' ? <Link to="/settings/plugins" className="text-ink-soft underline underline-offset-2" data-browser-webbridge-link>{t('st.browser.other.webbridge.action')}</Link> : <Tag>{t('st.browser.other.state')}</Tag>}
            </dt>
            <dd className="max-w-[62ch]">{t(row.condition)}</dd>
          </div>
        ))}
      </dl>
    </AdvancedDetails>
  );
}

/**
 * Running resources and capabilities of the open connection, folded, because
 * opening it costs something: the target list is read from the connected daemon,
 * and the catalogue read starts this connection's managed backend (it never
 * launches Chromium; schemas are a second, separate opt-in). The status facts
 * are the read's own fields; nothing here is inferred and no context tree is
 * drawn, because the service does not report one — the catalogue's own
 * `contextIsolation` token is shown as the server sent it.
 */
export function BrowserRuntimeDetails({ id, status }: { readonly id: string; readonly status: BrowserStatus }) {
  const { t, locale } = useI18n();
  const { client, scopeId } = useConnection();
  const [opened, setOpened] = useState(false);
  const [readCatalog, setReadCatalog] = useState(false);
  const [withSchemas, setWithSchemas] = useState(false);
  const [search, setSearch] = useState('');
  const checkedAt = whenText(locale, status.checkedAt);
  const live = LIVE_STATES.has(status.state);

  // Reading the daemon's targets never attaches or launches anything, so it can
  // follow the fold. A reconnect bumps the generation and makes this stale.
  const tabsQuery = useQuery({
    queryKey: browserKeys.tabs(scopeId, id, status.generation),
    queryFn: () => browserApi(client).tabs(id),
    enabled: opened && live,
    staleTime: 5_000,
  });
  // The catalogue is not read by opening the fold: the call opens the managed
  // backend, which is a side effect a person asks for.
  const catalogQuery = useQuery({
    queryKey: browserKeys.catalog(scopeId, id, status.generation, withSchemas),
    queryFn: () => browserApi(client).catalog(id, { includeSchema: withSchemas }),
    enabled: opened && readCatalog,
    staleTime: 60_000,
  });

  const capabilities = catalogQuery.data?.capabilities ?? [];
  const needle = search.trim().toLowerCase();
  const hits = needle === '' ? [] : capabilities.filter((capability) =>
    `${capability.name} ${capability.description} ${capability.group}`.toLowerCase().includes(needle));
  const groups = new Map<string, number>();
  for (const capability of capabilities) groups.set(capability.group, (groups.get(capability.group) ?? 0) + 1);
  // A very common word can match half the catalogue; the rest is one narrowing
  // away rather than a wall of rows.
  const HIT_LIMIT = 25;

  return (
    <AdvancedDetails summary={t('st.browser.runtimeTitle')} data-browser-runtime-tree
      onToggle={(event) => { setOpened((event.currentTarget as HTMLDetailsElement).open); }}>
      <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-ink-faint">{t('st.browser.detail.executionHost')}</dt>
        <dd className="min-w-0 break-all font-mono text-ink-soft" data-browser-execution-host>{status.executionHost}</dd>
        <dt className="text-ink-faint">{t('st.browser.detail.ownership')}</dt>
        <dd className="text-ink-soft" data-browser-ownership={status.ownership ?? 'unknown'}>
          {status.ownership === undefined ? t('st.browser.ownership.unknown')
            : status.ownership === 'managed-profile' ? t('st.browser.ownership.managedProfile')
              : t('st.browser.ownership.externalBrowser')}
        </dd>
        {status.runtimeSession === undefined ? null : (
          <>
            <dt className="text-ink-faint">{t('st.browser.detail.runtimeSession')}</dt>
            <dd className="min-w-0 break-all font-mono text-ink-soft" data-browser-runtime-session>{status.runtimeSession}</dd>
          </>
        )}
        {status.profilePath === undefined ? null : (
          <>
            <dt className="text-ink-faint">{t('st.browser.detail.resolvedProfile')}</dt>
            <dd className="min-w-0 break-all font-mono text-ink-soft" data-browser-resolved-profile>{status.profilePath}</dd>
          </>
        )}
        <dt className="text-ink-faint">{t('st.browser.detail.generation')}</dt>
        <dd className="text-ink-soft tabular-nums" data-browser-generation>{status.generation}</dd>
        <dt className="text-ink-faint">{t('st.browser.detail.driverVersion')}</dt>
        <dd className="text-ink-soft" data-browser-driver-version>
          {status.driverVersion ?? t('st.browser.detail.driverUnknown')}
          <span className="text-ink-faint"> · {t('st.browser.detail.driverRequirement', { version: AGENT_BROWSER_VERSION, markers: AGENT_BROWSER_MARKERS })}</span>
        </dd>
        <dt className="text-ink-faint">{t('st.browser.detail.checkedAt')}</dt>
        <dd className="text-ink-soft">{checkedAt ?? t('st.browser.detail.checkedNever')}</dd>
        {status.currentCall === undefined ? null : (
          <>
            <dt className="text-ink-faint">{t('st.browser.detail.currentCall')}</dt>
            <dd className="min-w-0 break-all font-mono text-ink-soft" data-browser-current-call>
              {`${status.currentCall.tool} · ${status.currentCall.sessionId} · ${status.currentCall.agentId}${status.currentCall.tab === undefined ? '' : ` · ${status.currentCall.tab}`}`}
            </dd>
          </>
        )}
      </dl>

      {/* The daemon's own target list. Not connected is a real answer here, not
          an empty one, so the three states stay apart. */}
      <div className="space-y-1" data-browser-tabs-section>
        <p className="flex items-baseline gap-x-2 font-medium">
          {t('st.browser.tabs.title')}
          {opened && tabsQuery.data !== undefined ? (
            <span className="font-mono text-[11px] tabular-nums text-ink-faint" data-browser-tabs-count>{tabsQuery.data.tabs.length}</span>
          ) : null}
        </p>
        {!live ? <p className="max-w-[62ch]" data-browser-tabs-notlive>{t('st.browser.tabs.notLive')}</p> : null}
        {live && tabsQuery.isPending ? <p role="status">{t('st.browser.tabs.loading')}</p> : null}
        {live && tabsQuery.isError ? <InlineError error={tabsQuery.error} /> : null}
        {live && tabsQuery.data !== undefined && tabsQuery.data.tabs.length === 0
          ? <p className="max-w-[62ch]" data-browser-tabs-empty>{t('st.browser.tabs.empty')}</p> : null}
        {live && tabsQuery.data !== undefined && tabsQuery.data.tabs.length > 0 ? (
          <ul className="space-y-1" data-browser-tabs>
            {tabsQuery.data.tabs.map((tab) => (
              <li key={tab.tabId} data-browser-tab={tab.tabId} className="min-w-0">
                <span className="flex min-w-0 items-baseline gap-x-2">
                  <span className="min-w-0 flex-1 truncate text-ink-soft" title={tab.title ?? tab.url ?? tab.targetId}>
                    {tab.title ?? tab.url ?? t('st.browser.tabs.untitled')}
                  </span>
                  {tab.active === true ? <Tag tone="accent">{t('st.browser.tabs.active')}</Tag> : null}
                  {tab.label === undefined ? null : <Tag>{tab.label}</Tag>}
                </span>
                <span className="block truncate font-mono text-[11px] text-ink-faint" title={tab.targetId}>{tab.targetId}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* The managed backend's catalogue. Reading it starts that backend, so it
          waits for a press; schemas wait for a second one. */}
      <div className="space-y-1.5" data-browser-catalog-section>
        <p className="font-medium">{t('st.browser.catalog.title')}</p>
        {!readCatalog ? (
          <>
            <p className="max-w-[62ch]">{t(live ? 'st.browser.catalog.readHint' : 'st.browser.catalog.readHintIdle')}</p>
            <button type="button" className={SECONDARY_BUTTON} data-browser-catalog-read
              onClick={() => { setReadCatalog(true); }}>
              {t('st.browser.catalog.read')}
            </button>
          </>
        ) : null}
        {readCatalog && catalogQuery.isPending ? <p role="status">{t('st.browser.catalog.loading')}</p> : null}
        {readCatalog && catalogQuery.isError ? <InlineError error={catalogQuery.error} /> : null}
        {readCatalog && catalogQuery.data !== undefined ? (
          <div className="space-y-1.5" data-browser-catalog>
            <p className="text-ink-soft">
              <span className="font-mono tabular-nums text-ink" data-browser-catalog-count>{catalogQuery.data.backendToolCount}</span>
              {' '}{t('st.browser.catalog.backendCount')}
              <span className="text-ink-faint"> · {t('st.browser.catalog.isolation')} <span className="font-mono">{catalogQuery.data.contextIsolation}</span></span>
            </p>
            {capabilities.length === 0 ? <p data-browser-catalog-empty>{t('st.browser.catalog.empty')}</p> : (
              <>
                <input className={`${INPUT} max-w-[22rem]`} value={search} spellCheck={false} autoComplete="off"
                  aria-label={t('st.browser.catalog.searchLabel')}
                  placeholder={t('st.browser.catalog.searchPlaceholder')}
                  data-browser-catalog-search
                  onChange={(event) => { setSearch(event.target.value); }} />
                {needle === '' ? (
                  <ul className="flex flex-wrap gap-1.5" data-browser-catalog-groups>
                    {[...groups].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([group, count]) => (
                      <li key={group}>
                        <button type="button" data-browser-catalog-group={group}
                          className="inline-flex items-baseline gap-1.5 rounded-md px-2 py-0.5 text-[12px] text-ink-soft hover:bg-ink/[0.05] hover:text-ink"
                          onClick={() => { setSearch(group); }}>
                          {groupLabel(t, group)}
                          <span className="font-mono tabular-nums text-[11px] text-ink-faint">{count}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {needle !== '' && hits.length === 0 ? <p data-browser-catalog-nomatch>{t('st.browser.catalog.noMatch')}</p> : null}
                {hits.length > 0 ? (
                  <ul className="space-y-1.5" data-browser-catalog-hits>
                    {hits.slice(0, HIT_LIMIT).map((capability) => (
                      <li key={capability.name} data-browser-capability={capability.name} className="min-w-0">
                        <p className="flex flex-wrap items-baseline gap-x-2">
                          <span className="break-all font-mono text-[12px] text-ink">{capability.name}</span>
                          <Tag>{groupLabel(t, capability.group)}</Tag>
                          <span className="text-[11px] text-ink-faint">{surfaceLabel(t, capability.surface)}</span>
                        </p>
                        <p className="max-w-[62ch] text-ink-soft">{capability.description}</p>
                        {capability.inputSchema === undefined ? null : (
                          <details data-browser-catalog-schema={capability.name}>
                            <summary className="cursor-pointer select-none text-[11px] text-ink-faint hover:text-ink">
                              {t('st.browser.catalog.schema')}
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-ink/[0.03] p-2 font-mono text-[11px] text-ink-soft">
                              {JSON.stringify(capability.inputSchema, null, 2)}
                            </pre>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {hits.length > HIT_LIMIT ? (
                  <p className="text-ink-faint">{t('st.browser.catalog.more', { count: hits.length - HIT_LIMIT })}</p>
                ) : null}
                <div data-browser-catalog-schema-option>
                  <Toggle label={t('st.browser.catalog.withSchemas')} checked={withSchemas}
                    onChange={(next) => { setWithSchemas(next); }} />
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    </AdvancedDetails>
  );
}

/** Group names come from the backend's own bucketing; an unknown one stays as sent. */
function groupLabel(t: ReturnType<typeof useI18n>['t'], group: string): string {
  const key = GROUP_KEYS[group];
  return key === undefined ? group : t(key);
}

/** The three surfaces the route derives; an unknown one stays as sent. */
function surfaceLabel(t: ReturnType<typeof useI18n>['t'], surface: string): string {
  const key = SURFACE_KEYS[surface];
  return key === undefined ? surface : t(key);
}

const GROUP_KEYS: Readonly<Record<string, I18nKey>> = {
  page: 'st.browser.group.page',
  network: 'st.browser.group.network',
  state: 'st.browser.group.state',
  debug: 'st.browser.group.debug',
  input: 'st.browser.group.input',
  react: 'st.browser.group.react',
};

const SURFACE_KEYS: Readonly<Record<string, I18nKey>> = {
  operation: 'st.browser.surface.operation',
  lifecycle: 'st.browser.surface.lifecycle',
  administrative: 'st.browser.surface.administrative',
};
