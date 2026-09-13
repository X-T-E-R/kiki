import { useI18n } from '../../../i18n';
import { generalIssueMessageKey, sourceIssueMessageKey } from './types';

/**
 * Shared issue list for the nb-search editor: every known code renders as a
 * plain-language sentence. Config-source codes keep the recovery wording only
 * (their raw code would read as noise); lane/pipeline codes keep the raw code
 * alongside the sentence so the entry stays traceable to server logs; unknown
 * codes stay raw so future backend codes still surface verbatim.
 */
export function NbSearchIssues({ issues }: { issues: readonly string[] }) {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1">
      {issues.map((code) => {
        const sourceKey = sourceIssueMessageKey(code);
        if (sourceKey !== undefined) {
          return (
            <li key={code} className="text-[11px] leading-relaxed text-danger">
              {t(sourceKey)}
            </li>
          );
        }
        const generalKey = generalIssueMessageKey(code);
        if (generalKey !== undefined) {
          return (
            <li key={code} className="text-[11px] leading-relaxed text-danger">
              {t(generalKey)}{' '}
              <span className="font-mono text-[10px] text-danger/70">({code})</span>
            </li>
          );
        }
        return (
          <li key={code} className="font-mono text-[10.5px] text-danger">
            {code}
          </li>
        );
      })}
    </ul>
  );
}
