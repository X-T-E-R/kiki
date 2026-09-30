import { useEffect, useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import type { NamedAgentProfile } from '../../../lib/client';
import { useConnection } from '../../../state/connection';
import { FeedbackLine, Hint } from '../../controls';
import { SettingsDraftFooter } from '../SettingsPrimitives';
import { useSavedTick } from '../useSavedTick';
import { writeScope } from './profileDraft';

/**
 * The whole file, frontmatter and body, as the fallback for every field the
 * form does not model. It is a separate transaction from the form: the form
 * reloads from the server echo after a raw save, and the raw text reloads
 * from disk after a form save, so the two never hold diverging drafts.
 */
export function RawPanel({ profile, writable, onSaved, reloadToken }: {
  profile: NamedAgentProfile;
  writable: boolean;
  onSaved: (updated: NamedAgentProfile) => void;
  /** Changes after a form save so the text reloads from disk. */
  reloadToken: number;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, pingSaved] = useSavedTick();
  // Read-only files never report dirty; the footer (writable only) owns the reporter otherwise.
  const dirty = writable && text !== null && baseline !== null && text !== baseline;

  useEffect(() => {
    if (profile.source_file === undefined) return;
    let cancelled = false;
    setError(null);
    client.readHostFile(profile.source_file).then((value) => {
      if (cancelled) return;
      setText(value); setBaseline(value);
    }).catch((reason: unknown) => { if (!cancelled) setError(errorText(locale, reason)); });
    return () => { cancelled = true; };
  }, [client, profile.source_file, reloadToken, locale]);

  const save = async () => {
    if (!writable || text === null || profile.workspace_id === undefined) return;
    setSaving(true); setError(null);
    try {
      const updated = await client.updateNamedAgentProfile(profile.name, {
        scope: writeScope(profile), workspace_id: profile.workspace_id, source_file: profile.source_file, raw_text: text,
      });
      setBaseline(text); pingSaved();
      onSaved(updated);
    } catch (reason) {
      setError(errorText(locale, reason));
    } finally { setSaving(false); }
  };

  if (profile.source_file === undefined) {
    return <div data-profile-raw className="flex min-h-0 flex-1 flex-col gap-2">
      <Hint>{t('st.profiles.rawBuiltin')}</Hint>
      {profile.prompt !== undefined ? <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-hairline bg-paper p-3 font-mono text-[12px] leading-relaxed text-ink-soft">{profile.prompt}</pre> : null}
    </div>;
  }
  return <div data-profile-raw className="flex min-h-0 flex-1 flex-col gap-2">
    <p className="text-[12px] text-ink-faint">{t(writable ? 'st.profiles.rawHint' : 'st.profiles.rawReadOnly')}</p>
    {text === null && error === null ? <Hint>{t('st.namedAgents.rawLoading')}</Hint> : null}
    {text !== null ? <textarea aria-label={t('st.profiles.rawLabel', { file: profile.source_file })} spellCheck={false}
      readOnly={!writable} value={text} onChange={(event) => { setText(event.target.value); }}
      className="min-h-[24rem] flex-1 resize-none rounded-lg border border-hairline bg-paper p-3 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-selected-ink" /> : null}
    {error !== null ? <div data-raw-error className="whitespace-pre-wrap"><FeedbackLine feedback={{ tone: 'error', text: error }} /></div> : null}
    {writable ? <SettingsDraftFooter id={`agent-raw:${profile.source_file}`} dirty={dirty} saving={saving} saved={saved}
      saveLabel={t('st.namedAgents.saveRaw')} onSave={() => void save()}
      onDiscard={() => { setText(baseline); setError(null); }} /> : null}
  </div>;
}
