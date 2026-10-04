import type { NbSearchDraft } from '@kiki/session-core/settings';
import type { NbSearchTestStatus } from '@kiki/protocol';
import { SectionCard } from '../SectionCard';
import { SettingsGroup } from '../fields';
import { FORM_LABEL } from '../SettingsPrimitives';
import { FeedbackLine, Hint } from '../../controls';
import { useI18n } from '../../../i18n';
import { fetchUrlState, webSearchState } from './types';
import { NbSearchReadinessRow } from './NbSearchReadinessRow';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { NbSearchFileScopeEditor } from './NbSearchFileScopeEditor';
import { NbSearchQualityEditor } from './NbSearchQualityEditor';
import type { NbSearchAdvancedBinding } from './advancedSupport';

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  /** One plain sentence on what changing this number does. */
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  // Same rule the save path applies (parsePositiveInt): empty inherits the
  // runtime default; anything else must be a non-negative whole number.
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  const invalid = trimmed !== '' && (!Number.isInteger(numeric) || numeric < 0);
  return (
    <label className={FORM_LABEL}>
      {label}
      <input
        className={`${INPUT} mt-1 font-mono`}
        inputMode="numeric"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {invalid ? (
        <p role="alert" data-field-issue className="mt-1 font-normal text-[12px] leading-4 text-danger">
          {t('st.nbSearch.invalidNumber', { value: trimmed })}
        </p>
      ) : (
        <span className="mt-1 block font-normal text-[11px] leading-relaxed text-ink-faint">
          {hint}
        </span>
      )}
    </label>
  );
}

// A sub-step of the card, not a box inside it: the shared SettingsGroup
// heading and hairline, so the three groups read like every other card.
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <SettingsGroup title={title}>{children}</SettingsGroup>;
}

export type TestRun =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'ok'; readonly result: NbSearchTestStatus }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'cancelled' };

export function NbSearchAdvancedTab({
  execution,
  testRun,
  onUpdateExecution,
  onRunCheck,
  onCancelCheck,
  saving = false,
  advanced,
}: {
  execution: NbSearchDraft['execution'];
  testRun: TestRun;
  onUpdateExecution: (patch: Partial<NbSearchDraft['execution']>) => void;
  onRunCheck: () => void;
  onCancelCheck: () => void;
  saving?: boolean;
  /** Present once the page hands its draft over; adds the fetch-scope and quality domains. */
  advanced?: NbSearchAdvancedBinding;
}) {
  const { t } = useI18n();

  return (
    <div className="space-y-4">
      {/* Execution budgets card with anchor st-card-search-execution */}
      <SectionCard id="st-card-search-execution" title={t('st.nbSearch.executionTitle')}>
        <div className="space-y-3">
          <Hint>{t('st.nbSearch.executionHint')}</Hint>
          <fieldset disabled={saving} className="space-y-3 disabled:opacity-60">
            <Group title={t('st.nbSearch.groupBudgets')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField
                  label={t('st.nbSearch.maxProviderCalls')}
                  hint={t('st.nbSearch.maxProviderCallsHint')}
                  value={execution.maxProviderCalls}
                  onChange={(maxProviderCalls) => {
                    onUpdateExecution({ maxProviderCalls });
                  }}
                />
                <NumberField
                  label={t('st.nbSearch.maxConcurrency')}
                  hint={t('st.nbSearch.maxConcurrencyHint')}
                  value={execution.maxConcurrency}
                  onChange={(maxConcurrency) => {
                    onUpdateExecution({ maxConcurrency });
                  }}
                />
                <NumberField
                  label={t('st.nbSearch.retryCount')}
                  hint={t('st.nbSearch.retryCountHint')}
                  value={execution.retryCount}
                  onChange={(retryCount) => {
                    onUpdateExecution({ retryCount });
                  }}
                />
              </div>
            </Group>

            <Group title={t('st.nbSearch.groupTimeouts')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField
                  label={t('st.nbSearch.searchTimeout')}
                  hint={t('st.nbSearch.searchTimeoutHint')}
                  value={execution.searchTimeoutMs}
                  onChange={(searchTimeoutMs) => {
                    onUpdateExecution({ searchTimeoutMs });
                  }}
                />
                <NumberField
                  label={t('st.nbSearch.fetchTimeout')}
                  hint={t('st.nbSearch.fetchTimeoutHint')}
                  value={execution.fetchTimeoutMs}
                  onChange={(fetchTimeoutMs) => {
                    onUpdateExecution({ fetchTimeoutMs });
                  }}
                />
              </div>
            </Group>

            <Group title={t('st.nbSearch.groupFetchLimits')}>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField
                  label={t('st.nbSearch.maxInlineBytes')}
                  hint={t('st.nbSearch.maxInlineBytesHint')}
                  value={execution.maxInlineBytes}
                  onChange={(maxInlineBytes) => {
                    onUpdateExecution({ maxInlineBytes });
                  }}
                />
                <NumberField
                  label={t('st.nbSearch.maxSourceBytes')}
                  hint={t('st.nbSearch.maxSourceBytesHint')}
                  value={execution.fetchMaxSourceBytes}
                  onChange={(fetchMaxSourceBytes) => {
                    onUpdateExecution({ fetchMaxSourceBytes });
                  }}
                />
                <NumberField
                  label={t('st.nbSearch.maxResponseBytes')}
                  hint={t('st.nbSearch.maxResponseBytesHint')}
                  value={execution.fetchMaxResponseBytes}
                  onChange={(fetchMaxResponseBytes) => {
                    onUpdateExecution({ fetchMaxResponseBytes });
                  }}
                />
                <NumberField
                  label={t('st.nbSearch.maxContentChars')}
                  hint={t('st.nbSearch.maxContentCharsHint')}
                  value={execution.fetchMaxContentChars}
                  onChange={(fetchMaxContentChars) => {
                    onUpdateExecution({ fetchMaxContentChars });
                  }}
                />
                <NumberField
                  label={t('st.nbSearch.maxRedirects')}
                  hint={t('st.nbSearch.maxRedirectsHint')}
                  value={execution.fetchMaxRedirects}
                  onChange={(fetchMaxRedirects) => {
                    onUpdateExecution({ fetchMaxRedirects });
                  }}
                />
              </div>
            </Group>

            {/* The two domains below belong to the same fetch behaviour as the
                limits above, so they live in this card instead of a fifth
                section the page's deep links do not know about. Each is a group
                of its own and opens on demand. */}
            {advanced === undefined ? null : (
              <>
                <Group title={t('st.nbSearch.fileScope.title')}>
                  <NbSearchFileScopeEditor binding={advanced} saving={saving} />
                </Group>
                <Group title={t('st.nbSearch.quality.title')}>
                  <NbSearchQualityEditor binding={advanced} saving={saving} />
                </Group>
              </>
            )}
          </fieldset>
        </div>
      </SectionCard>

      {/* Diagnostics card with anchor st-card-search-diagnostics */}
      <SectionCard id="st-card-search-diagnostics" title={t('st.nbSearch.diagnosticsTitle')}>
        <div className="space-y-3">
          <Hint>{t('st.nbSearch.diagnosticsHint')}</Hint>
          <div className="flex items-center gap-2">
            {testRun.status === 'running' ? (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={onCancelCheck}
              >
                {t('st.nbSearch.cancel')}
              </button>
            ) : (
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={onRunCheck}
              >
                {t('st.nbSearch.runCheck')}
              </button>
            )}
            {testRun.status === 'running' ? (
              <span className="text-[11px] text-ink-faint">
                {t('st.nbSearch.running')}
              </span>
            ) : null}
          </div>

          {testRun.status === 'ok' ? (
            <div className="space-y-2 mt-2">
              <p className="font-mono text-[11px] text-ink-faint">
                {t('st.nbSearch.lastChecked', { revision: testRun.result.revision })}
              </p>
              {/* The readiness check reads the saved configuration. It never
                  contacts a provider, so a green row must not read as "paid
                  search verified". */}
              <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-check-scope>
                {t('st.nbSearch.advanced.checkScope')}
              </p>
              <NbSearchReadinessRow
                label={t('st.nbSearch.webSearch')}
                state={webSearchState(testRun.result.search)}
                readiness={testRun.result.search}
              />
              <NbSearchReadinessRow
                label={t('st.nbSearch.fetchUrl')}
                state={fetchUrlState(testRun.result.fetch)}
                readiness={testRun.result.fetch}
              />
            </div>
          ) : null}

          {testRun.status === 'error' ? (
            <FeedbackLine
              feedback={{
                tone: 'error',
                text: `${t('st.nbSearch.checkFailed')}: ${testRun.message}`,
              }}
            />
          ) : null}

          {testRun.status === 'cancelled' ? (
            <FeedbackLine
              feedback={{
                tone: 'info',
                text: t('st.nbSearch.cancelled'),
              }}
            />
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}
