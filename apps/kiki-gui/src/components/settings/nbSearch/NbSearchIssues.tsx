import type { I18nKey } from '@kiki/session-core/i18n';
import { useI18n } from '../../../i18n';
import { generalIssueMessageKey, sourceIssueMessageKey } from './types';

/**
 * Shared issue list for the nb-search editor: every known code renders as a
 * plain-language sentence in the row's own words — a fetch row never says
 * "search method". The raw code stays on the sentence's title, traceable to
 * server logs without printing as user text; unknown codes stay raw so future
 * backend codes still surface verbatim.
 */

/** Codes whose sentence names the tool that reported them. */
const FETCH_WORDING: Readonly<Record<string, I18nKey>> = {
  LANE_NOT_CONFIGURED: 'st.nbSearch.issue.fetch.LANE_NOT_CONFIGURED',
};

export function NbSearchIssues({ issues, context = 'search' }: { issues: readonly string[]; context?: 'search' | 'fetch' }) {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1">
      {issues.map((code) => {
        const sourceKey = sourceIssueMessageKey(code);
        const generalKey = generalIssueMessageKey(code);
        const key = sourceKey ?? (context === 'fetch' ? FETCH_WORDING[code] : undefined) ?? generalKey;
        if (key !== undefined) {
          return (
            <li key={code} className="text-[11px] leading-relaxed text-danger" title={code}>
              {t(key)}
            </li>
          );
        }
        return (
          <li key={code} className="font-mono text-[11px] text-danger">
            {code}
          </li>
        );
      })}
    </ul>
  );
}
