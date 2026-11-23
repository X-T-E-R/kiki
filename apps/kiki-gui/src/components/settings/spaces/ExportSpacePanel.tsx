import { useId, useMemo, useState } from 'react';

import type {
  PortableSpaceEndpoint,
  PortableSpaceEncryption,
  PortableSpaceExportReceipt,
  PortableSpaceFormat,
  PortableSpaceMode,
  PortableSpaceSecretMode,
  PortableSpaceSourceRecord,
} from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useHost } from '../../../host';
import { useI18n } from '../../../i18n';
import type { KikiClient } from '../../../lib/client';
import {
  DEFAULT_DOMAIN_GROUP_IDS,
  PORTABLE_DOMAIN_GROUPS,
  endpointKey,
  expandDomainGroups,
  portableSpacesApi,
  suggestExportDestination,
} from '../../../lib/portableSpaces';
import { MAIN_SPACE_ID, type SpaceListItem } from '../../../lib/spaces';
import { FeedbackLine, Toggle, type Feedback } from '../../controls';
import { SidePanel } from '../../SidePanel';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../../ui';
import { FieldIssue, FORM_LABEL, SettingsSegmented, SettingsSelect } from '../SettingsPrimitives';

type DirSecretChoice = 'sealed' | 'plain' | 'none';
type DirSealEncChoice = 'x25519' | 'passphrase';
type AgeSecretChoice = 'x25519' | 'passphrase' | 'none';
type TgzSecretChoice = 'none' | 'plain';
type SessionChoice = 'none' | 'recent5';

interface SourceOption {
  readonly value: string;
  readonly label: string;
  readonly endpoint: PortableSpaceEndpoint;
  readonly slugSeed: string;
}

export interface ExportSpacePanelProps {
  readonly client: KikiClient;
  readonly token?: string;
  readonly spaces: readonly SpaceListItem[];
  readonly portableSources: readonly PortableSpaceSourceRecord[];
  readonly deviceRecipient?: string;
  readonly mainPath: string;
  readonly intent: 'export' | 'fork';
  readonly initialSource?: PortableSpaceEndpoint;
  readonly initialMode?: PortableSpaceMode;
  readonly onClose: () => void;
  readonly onDone: (receipt: PortableSpaceExportReceipt) => void;
}

export function ExportSpacePanel({
  client,
  token,
  spaces,
  portableSources,
  deviceRecipient,
  mainPath,
  intent,
  initialSource,
  initialMode,
  onClose,
  onDone,
}: ExportSpacePanelProps) {
  const host = useHost();
  const { t, locale } = useI18n();
  const formId = useId();
  const destId = useId();
  const destIssueId = useId();
  const passphraseId = useId();
  const passphraseIssueId = useId();
  const recipientsId = useId();
  const sourceUnlockId = useId();

  const sourceOptions = useMemo<readonly SourceOption[]>(() => {
    const liveOptions: SourceOption[] = spaces.map((space) => {
      const label = space.id === MAIN_SPACE_ID ? t('st.spaces.main') : space.name;
      return {
        value: `live:${space.id}`,
        label,
        endpoint: { kind: 'live', spaceId: space.id },
        slugSeed: space.id === MAIN_SPACE_ID ? 'main-space' : space.name,
      };
    });
    const sourceRecOptions: SourceOption[] = portableSources.map((source) => ({
      value: `source:${source.id}`,
      label: source.label,
      endpoint: source.endpoint,
      slugSeed: source.label,
    }));
    if (liveOptions.length === 0) {
      liveOptions.push({
        value: `live:${MAIN_SPACE_ID}`,
        label: t('st.spaces.main'),
        endpoint: { kind: 'live', spaceId: MAIN_SPACE_ID },
        slugSeed: 'main-space',
      });
    }
    return [...liveOptions, ...sourceRecOptions];
  }, [spaces, portableSources, t]);

  const defaultSourceValue = useMemo(() => {
    if (initialSource !== undefined) {
      const targetKey = endpointKey(initialSource);
      const match = sourceOptions.find((opt) => endpointKey(opt.endpoint) === targetKey);
      if (match !== undefined) return match.value;
    }
    return sourceOptions[0]?.value ?? `live:${MAIN_SPACE_ID}`;
  }, [initialSource, sourceOptions]);

  const [sourceValue, setSourceValue] = useState(defaultSourceValue);
  const [spaceMode, setSpaceMode] = useState<PortableSpaceMode>(initialMode ?? 'full');
  const [format, setFormat] = useState<PortableSpaceFormat>('dir');
  const [gitInit, setGitInit] = useState(false);
  const [dirSecret, setDirSecret] = useState<DirSecretChoice>('sealed');
  const [dirSealEnc, setDirSealEnc] = useState<DirSealEncChoice>('x25519');
  const [ageSecret, setAgeSecret] = useState<AgeSecretChoice>('x25519');
  const [tgzSecret, setTgzSecret] = useState<TgzSecretChoice>('none');
  const [passphrase, setPassphrase] = useState('');
  const [sourcePassphrase, setSourcePassphrase] = useState('');
  const [recipientsText, setRecipientsText] = useState(deviceRecipient ?? '');
  const [destination, setDestination] = useState('');
  const [destEdited, setDestEdited] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<ReadonlySet<string>>(() => new Set(DEFAULT_DOMAIN_GROUP_IDS));
  const [sessionChoice, setSessionChoice] = useState<SessionChoice>('none');
  const [destIssue, setDestIssue] = useState<string | null>(null);
  const [passphraseIssue, setPassphraseIssue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const selectedSource = sourceOptions.find((opt) => opt.value === sourceValue) ?? sourceOptions[0]!;
  const suggestedDest = suggestExportDestination(
    mainPath,
    spaceMode === 'overlay' ? `${selectedSource.slugSeed}-overlay` : selectedSource.slugSeed,
    format,
  );
  const effectiveDest = destEdited ? destination : suggestedDest;

  const needsPassphrase =
    (format === 'age' && ageSecret === 'passphrase') ||
    (format === 'dir' && dirSecret === 'sealed' && dirSealEnc === 'passphrase');
  const showRecipients =
    (format === 'age' && ageSecret === 'x25519') ||
    (format === 'dir' && dirSecret === 'sealed' && dirSealEnc === 'x25519');
  const showSourceUnlock = selectedSource.endpoint.kind !== 'live';

  const toggleGroup = (id: string) => {
    setSelectedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const browse = async () => {
    if (host.pickDirectory === undefined) return;
    try {
      const picked = await host.pickDirectory();
      if (picked !== null) {
        setDestination(picked);
        setDestEdited(true);
        setDestIssue(null);
        setFeedback(null);
      }
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const resolveSecretPolicy = (): { secretMode: PortableSpaceSecretMode; encryption?: PortableSpaceEncryption } => {
    const parsedRecipients = recipientsText
      .split(/[\r\n,]+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (format === 'dir') {
      if (dirSecret === 'sealed') {
        if (dirSealEnc === 'passphrase') {
          return { secretMode: 'sealed', encryption: { mode: 'passphrase', passphrase: passphrase.trim() } };
        }
        return {
          secretMode: 'sealed',
          encryption: { mode: 'x25519', recipients: parsedRecipients.length > 0 ? parsedRecipients : undefined },
        };
      }
      return { secretMode: dirSecret };
    }
    if (format === 'age') {
      if (ageSecret === 'passphrase') {
        return { secretMode: 'sealed', encryption: { mode: 'passphrase', passphrase: passphrase.trim() } };
      }
      if (ageSecret === 'x25519') {
        return {
          secretMode: 'sealed',
          encryption: { mode: 'x25519', recipients: parsedRecipients.length > 0 ? parsedRecipients : undefined },
        };
      }
      return {
        secretMode: 'none',
        encryption: { mode: 'x25519', recipients: parsedRecipients.length > 0 ? parsedRecipients : undefined },
      };
    }
    return { secretMode: tgzSecret };
  };

  const submit = async () => {
    if (busy) return;
    const trimmedDest = effectiveDest.trim();
    const nextDestIssue = trimmedDest === '' ? t('st.portable.exportDestRequired') : null;
    const nextPassIssue = needsPassphrase && passphrase.trim() === '' ? t('st.portable.passphraseRequired') : null;
    setDestIssue(nextDestIssue);
    setPassphraseIssue(nextPassIssue);
    if (nextDestIssue !== null || nextPassIssue !== null) return;

    const { secretMode, encryption } = resolveSecretPolicy();
    const includeMemories = selectedGroups.has('memories');
    const includeSessions = sessionChoice === 'recent5';
    const domains = expandDomainGroups(selectedGroups, {
      includeCredentials: secretMode !== 'none',
      includeSessions,
    });

    const sourceUnlock = showSourceUnlock && sourcePassphrase.trim() !== ''
      ? { passphrase: sourcePassphrase.trim() }
      : undefined;

    setBusy(true);
    setFeedback(null);
    try {
      const api = portableSpacesApi(client, { token });
      const receipt = intent === 'fork'
        ? await api.fork({
          source: selectedSource.endpoint,
          destination: trimmedDest,
          format,
          overlay: spaceMode === 'overlay',
          secretMode,
          encryption,
          domains: domains.length > 0 ? domains : undefined,
          includeMemories,
          sourceUnlock,
        })
        : await api.exportSpace({
          source: selectedSource.endpoint,
          destination: trimmedDest,
          format,
          spaceMode,
          secretMode,
          encryption,
          domains: domains.length > 0 ? domains : undefined,
          sessions: includeSessions ? { mode: 'recent', count: 5 } : { mode: 'none' },
          includeMemories,
          gitInit: format === 'dir' ? gitInit : false,
          sourceUnlock,
        });
      onDone(receipt);
    } catch (error) {
      setBusy(false);
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  const title = t(intent === 'fork' ? 'st.portable.forkTitle' : 'st.portable.exportTitle');
  const submitLabel = busy
    ? t('st.portable.exporting')
    : t(intent === 'fork' ? 'st.portable.forkSubmit' : 'st.portable.exportSubmit');

  return (
    <SidePanel
      title={title}
      overlayId="portable-export-panel"
      width="lg"
      onClose={() => { if (!busy) onClose(); }}
      data={{ 'data-portable-export-panel': intent }}
      footer={(
        <>
          <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <span className="ml-auto" />
          <button
            type="submit"
            form={formId}
            data-portable-export-submit
            className={PRIMARY_BUTTON}
            disabled={busy || selectedGroups.size === 0}
          >
            {submitLabel}
          </button>
        </>
      )}
    >
      <form
        id={formId}
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor={`${formId}-source`} className={FORM_LABEL}>{t('st.portable.exportSource')}</label>
            <div className="mt-1.5">
              <SettingsSelect<string>
                id={`${formId}-source`}
                variant="form"
                ariaLabel={t('st.portable.exportSource')}
                dataAttr="data-portable-export-source"
                value={sourceValue}
                onChange={setSourceValue}
                choices={sourceOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
              />
            </div>
          </div>
          <div className="min-w-0">
            <span id={`${formId}-mode`} className={FORM_LABEL}>{t('st.portable.exportMode')}</span>
            <div className="mt-1.5">
              <SettingsSegmented<PortableSpaceMode>
                ariaLabelledBy={`${formId}-mode`}
                dataAttr="data-portable-export-mode"
                value={spaceMode}
                onChange={setSpaceMode}
                choices={[
                  { value: 'full', label: t('st.portable.exportModeFull') },
                  { value: 'overlay', label: t('st.portable.exportModeOverlay') },
                ]}
              />
            </div>
          </div>
        </div>

        {showSourceUnlock ? (
          <div>
            <label htmlFor={sourceUnlockId} className={FORM_LABEL}>{t('st.portable.sourceUnlockLabel')}</label>
            <input
              id={sourceUnlockId}
              type="password"
              data-portable-source-unlock
              value={sourcePassphrase}
              placeholder={t('st.portable.passphrasePlaceholder')}
              autoComplete="off"
              onChange={(event) => { setSourcePassphrase(event.target.value); }}
              className={`${INPUT} mt-1.5`}
            />
          </div>
        ) : null}

        <div className="space-y-3">
          <div>
            <span id={`${formId}-format`} className={FORM_LABEL}>{t('st.portable.exportFormat')}</span>
            <div className="mt-1.5">
              <SettingsSegmented<PortableSpaceFormat>
                ariaLabelledBy={`${formId}-format`}
                dataAttr="data-portable-export-format"
                value={format}
                onChange={(next) => {
                  setFormat(next);
                  setPassphraseIssue(null);
                }}
                choices={[
                  { value: 'dir', label: t('st.portable.exportFormatDir') },
                  { value: 'age', label: t('st.portable.exportFormatAge') },
                  { value: 'tgz', label: t('st.portable.exportFormatTgz') },
                ]}
              />
            </div>
          </div>

          {format === 'dir' && intent === 'export' ? (
            <div className="flex items-center justify-between gap-3 py-1" data-portable-git-init>
              <span className="text-[13px] text-ink">{t('st.portable.exportGitInit')}</span>
              <Toggle
                layout="bare"
                label={t('st.portable.exportGitInit')}
                checked={gitInit}
                onChange={setGitInit}
              />
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          <div>
            <span id={`${formId}-secret`} className={FORM_LABEL}>{t('st.portable.secretLabel')}</span>
            <div className="mt-1.5">
              {format === 'dir' ? (
                <SettingsSegmented<DirSecretChoice>
                  ariaLabelledBy={`${formId}-secret`}
                  dataAttr="data-portable-secret-policy"
                  value={dirSecret}
                  onChange={setDirSecret}
                  choices={[
                    { value: 'sealed', label: t('st.portable.secret.dirSealed') },
                    { value: 'plain', label: t('st.portable.secret.dirPlain') },
                    { value: 'none', label: t('st.portable.secret.none') },
                  ]}
                />
              ) : format === 'age' ? (
                <SettingsSegmented<AgeSecretChoice>
                  ariaLabelledBy={`${formId}-secret`}
                  dataAttr="data-portable-secret-policy"
                  value={ageSecret}
                  onChange={(next) => {
                    setAgeSecret(next);
                    setPassphraseIssue(null);
                  }}
                  choices={[
                    { value: 'x25519', label: t('st.portable.secret.ageX25519') },
                    { value: 'passphrase', label: t('st.portable.secret.agePassphrase') },
                    { value: 'none', label: t('st.portable.secret.noneShort') },
                  ]}
                />
              ) : (
                <SettingsSegmented<TgzSecretChoice>
                  ariaLabelledBy={`${formId}-secret`}
                  dataAttr="data-portable-secret-policy"
                  value={tgzSecret}
                  onChange={setTgzSecret}
                  choices={[
                    { value: 'none', label: t('st.portable.secret.noneShort') },
                    { value: 'plain', label: t('st.portable.secret.dirPlain') },
                  ]}
                />
              )}
            </div>
          </div>

          {format === 'dir' && dirSecret === 'sealed' ? (
            <div>
              <span id={`${formId}-dir-seal-enc`} className={FORM_LABEL}>{t('st.portable.dirSealEncLabel')}</span>
              <div className="mt-1.5">
                <SettingsSegmented<DirSealEncChoice>
                  ariaLabelledBy={`${formId}-dir-seal-enc`}
                  dataAttr="data-portable-dir-seal-enc"
                  value={dirSealEnc}
                  onChange={(next) => {
                    setDirSealEnc(next);
                    setPassphraseIssue(null);
                  }}
                  choices={[
                    { value: 'x25519', label: t('st.portable.enc.x25519') },
                    { value: 'passphrase', label: t('st.portable.enc.passphrase') },
                  ]}
                />
              </div>
            </div>
          ) : null}

          {needsPassphrase ? (
            <div>
              <label htmlFor={passphraseId} className={FORM_LABEL}>{t('st.portable.passphraseLabel')}</label>
              <input
                id={passphraseId}
                type="password"
                data-portable-export-passphrase
                value={passphrase}
                placeholder={t('st.portable.passphrasePlaceholder')}
                autoComplete="new-password"
                aria-invalid={passphraseIssue !== null}
                aria-describedby={passphraseIssue !== null ? passphraseIssueId : undefined}
                onChange={(event) => {
                  setPassphrase(event.target.value);
                  setPassphraseIssue(null);
                }}
                className={`${INPUT} mt-1.5`}
              />
              <FieldIssue id={passphraseIssueId} text={passphraseIssue} />
            </div>
          ) : null}

          {showRecipients ? (
            <div>
              <label htmlFor={recipientsId} className={FORM_LABEL}>{t('st.portable.recipientsLabel')}</label>
              <textarea
                id={recipientsId}
                rows={2}
                data-portable-export-recipients
                value={recipientsText}
                placeholder={t('st.portable.recipientsPlaceholder')}
                spellCheck={false}
                onChange={(event) => { setRecipientsText(event.target.value); }}
                className={`${INPUT} mt-1.5 font-mono text-[12px]`}
              />
            </div>
          ) : null}
        </div>

        <div>
          <label htmlFor={destId} className={FORM_LABEL}>{t('st.portable.exportDest')}</label>
          <div className="mt-1.5 flex gap-2">
            <input
              id={destId}
              data-portable-export-dest
              value={effectiveDest}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={destIssue !== null}
              aria-describedby={destIssue !== null ? destIssueId : undefined}
              onChange={(event) => {
                setDestination(event.target.value);
                setDestEdited(true);
                setDestIssue(null);
              }}
              className={`${INPUT} min-w-0 flex-1 font-mono text-[12px]`}
            />
            {format === 'dir' && host.pickDirectory !== undefined ? (
              <button type="button" className={SECONDARY_BUTTON} onClick={() => { void browse(); }}>
                {t('st.spaces.browse')}
              </button>
            ) : null}
          </div>
          <FieldIssue id={destIssueId} text={destIssue} />
        </div>

        <fieldset className="space-y-2.5">
          <legend className={FORM_LABEL}>{t('st.portable.domainsLabel')}</legend>
          <div className="grid gap-2 sm:grid-cols-2" data-portable-domain-checklist>
            {PORTABLE_DOMAIN_GROUPS.map((group) => {
              const checked = selectedGroups.has(group.id);
              return (
                <label
                  key={group.id}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-[13px] transition-colors ${
                    checked
                      ? 'border-selected-ink/40 bg-selected-ink/[0.04] text-ink'
                      : 'border-hairline bg-paper text-ink-soft hover:border-hairline-strong hover:text-ink'
                  }`}
                >
                  <input
                    type="checkbox"
                    data-portable-domain={group.id}
                    checked={checked}
                    onChange={() => { toggleGroup(group.id); }}
                    className="accent-[var(--color-selected-ink)]"
                  />
                  <span className="min-w-0 truncate">{t(group.labelKey)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {intent === 'export' ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <span id={`${formId}-sessions`} className="text-[13px] text-ink">{t('st.portable.sessionsLabel')}</span>
            <SettingsSegmented<SessionChoice>
              ariaLabelledBy={`${formId}-sessions`}
              dataAttr="data-portable-sessions-choice"
              value={sessionChoice}
              onChange={setSessionChoice}
              choices={[
                { value: 'none', label: t('st.portable.sessionsNone') },
                { value: 'recent5', label: t('st.portable.sessionsRecent5') },
              ]}
            />
          </div>
        ) : null}

        <FeedbackLine feedback={feedback} />
      </form>
    </SidePanel>
  );
}
