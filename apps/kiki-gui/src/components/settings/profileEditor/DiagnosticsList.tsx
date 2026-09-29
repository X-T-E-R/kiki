import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { diagnosticTone, profileLocation, type ProfileDiagnostic } from './diagnostics';

const FIELD_KEYS = {
  model_alias: 'st.profiles.model',
  model_profiles: 'st.profiles.modelProfiles',
  allowed_models: 'st.profiles.allowedModels',
  lease: 'st.profiles.subagents',
} as const;

/**
 * The profile's problems and provenance notes, stated as facts with the
 * file or alias involved. Warnings first; nothing renders when all is well.
 */
export function DiagnosticsList({ diagnostics, onOpenWinner }: {
  diagnostics: readonly ProfileDiagnostic[];
  onOpenWinner?: () => void;
}) {
  const { t, tp } = useI18n();
  if (diagnostics.length === 0) return null;
  const sorted = diagnostics.toSorted((a, b) => Number(diagnosticTone(a) === 'note') - Number(diagnosticTone(b) === 'note'));
  const line = (item: ProfileDiagnostic) => {
    switch (item.kind) {
      case 'aliasMissing':
        return item.via === undefined
          ? t('st.profiles.diag.aliasMissing', { alias: item.alias, field: t(FIELD_KEYS[item.field]) })
          : t('st.profiles.diag.leaseAliasMissing', { alias: item.alias, name: item.via });
      case 'subagentMissing': return t('st.profiles.diag.subagentMissing', { name: item.name });
      case 'shadowedBy': return t('st.profiles.diag.shadowedBy', { file: profileLocation(item.winner) });
      case 'shadows': return tp('st.profiles.diag.shadowsList', item.hidden.length);
      case 'builtinModified': return t(item.status === 'update-available' ? 'st.profiles.diag.builtinUpdate' : 'st.profiles.diag.builtinModified');
      case 'overridesBuiltin': return t('st.namedAgents.overridesBuiltin');
      case 'executorIgnored': return t('st.profiles.diag.executorIgnored', { fields: item.fields.join(', ') });
    }
  };
  return <ul className="space-y-1" data-profile-diagnostics aria-label={t('st.profiles.diagnostics')}>
    {sorted.map((item, index) => {
      const warning = diagnosticTone(item) === 'warning';
      return <li key={index} data-profile-diagnostic={item.kind}
        className={`flex items-start gap-2 text-[12px] leading-5 ${warning ? 'text-amber-ink' : 'text-ink-soft'}`}>
        <span className="mt-[3px] shrink-0">{warning ? <Icon name="warning" size={12} /> : <Icon name="dot" size={12} />}</span>
        <span className="min-w-0 break-words">
          {line(item)}
          {item.kind === 'shadowedBy' && onOpenWinner !== undefined ? <> <button type="button" onClick={onOpenWinner}
            className="underline decoration-current/40 underline-offset-2 hover:decoration-current">{t('st.profiles.openWinner')}</button></> : null}
          {item.kind === 'shadows' ? <ul data-shadowed-files className="mt-0.5 space-y-0.5">
            {item.hidden.map((file) => <li key={file} data-shadowed-file={file}
              className="break-all font-mono text-[11.5px] leading-4 text-ink-faint">{file}</li>)}
          </ul> : null}
        </span>
      </li>;
    })}
  </ul>;
}
