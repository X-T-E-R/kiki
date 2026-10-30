import type { ReactNode } from 'react';

import type { ModelCatalogItem } from '@kiki/protocol';
import { useI18n } from '../../../i18n';
import { AliasChips } from './fields';
import { EFFORTS, effortLabel } from './profileDraft';

export type RuleColumn = 'allow' | 'prefer' | 'avoid' | 'block';

export interface RuleRow {
  readonly id: string;
  readonly label: string;
  /** One cell per column the matrix shows; `null` = this column does not apply to the row. */
  readonly cells: Partial<Record<RuleColumn, ReactNode | null>>;
}

const COLUMN_KEY = { allow: 'st.profiles.ruleAllow', prefer: 'st.profiles.rulePrefer', avoid: 'st.profiles.ruleAvoid', block: 'st.profiles.ruleBlock' } as const;
const GRID = 'sm:grid-cols-[5.5rem_repeat(4,minmax(0,1fr))]';

/**
 * One rule card: rows are what is being ruled (models, effort, tools), columns
 * are how hard the rule is — only these, prefer, avoid, never. Every cell maps to
 * one frontmatter field, so the card is a presentation of the existing lists,
 * not a new model of them.
 */
export function RuleMatrix({ title, rows, action, dataRules }: {
  title: string;
  rows: readonly RuleRow[];
  action?: ReactNode;
  dataRules: string;
}) {
  const { t } = useI18n();
  const columns: readonly RuleColumn[] = ['allow', 'prefer', 'avoid', 'block'];
  const grid = GRID;
  return <section data-model-rules={dataRules} aria-label={title} className="min-w-0 space-y-2">
    <div className="flex min-h-7 items-center justify-between gap-2">
      <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
      {action}
    </div>
    <div className="min-w-0 rounded-lg border border-hairline">
      <div className={`hidden gap-x-4 border-b border-hairline px-3 py-1.5 text-[11.5px] text-ink-faint sm:grid ${grid}`} aria-hidden>
        <span />
        {columns.map((column) => <span key={column} data-rule-column={column}
          className={column === 'block' || column === 'allow' ? 'font-medium text-ink-soft' : 'text-ink-faint'}>{t(COLUMN_KEY[column])}</span>)}
      </div>
      {rows.map((row, index) => <div key={row.id} data-rule-row={row.id}
        className={`grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 px-3 py-2.5 ${grid} ${index > 0 ? 'border-t border-hairline' : ''}`}>
        <span className="pt-1 text-[12px] font-medium text-ink-soft">{row.label}</span>
        {columns.map((column) => {
          const cell = row.cells[column];
          if (cell === null || cell === undefined) return <span key={column} aria-hidden className="hidden h-7 items-center text-[12px] text-ink-faint/60 sm:inline-flex">—</span>;
          return <div key={column} data-rule-cell={column} className="min-w-0">
            <span className="mb-1 block text-[11px] text-ink-faint sm:hidden">{t(COLUMN_KEY[column])}</span>
            {cell}
          </div>;
        })}
      </div>)}
    </div>
  </section>;
}

/** Model aliases in one cell: chips plus an add picker; an empty allow list reads "Any". */
export function ModelCell({ id, values, onChange, models, disabled, any = false }: {
  id: string; values: readonly string[]; onChange: (next: string[]) => void; models: readonly ModelCatalogItem[];
  disabled: boolean;
  /** Shows "Any" while empty: an absent allow list does not limit. */
  any?: boolean;
}) {
  const { t } = useI18n();
  return <div className="flex min-w-0 flex-wrap items-center gap-1.5">
    {any && values.length === 0 ? <span className="text-[12px] text-ink-faint">{t('st.profiles.ruleAny')}</span> : null}
    <AliasChips id={id} values={values} models={models} disabled={disabled} addLabel={t('st.profiles.addModel')} onChange={onChange} />
  </div>;
}

/**
 * Effort levels as a toggle row. A set (`ordered` off) is stored in the fixed
 * level order; a preference list keeps the order it was written in and appends.
 */
export function EffortCell({ values, onChange, disabled, dataAttr, any = false, ordered = false, label }: {
  values: readonly string[]; onChange: (next: string[]) => void; disabled: boolean; dataAttr: string; any?: boolean;
  ordered?: boolean; label: string;
}) {
  const { t } = useI18n();
  const add = (level: string) => ordered ? [...values, level] : EFFORTS.filter((value) => value === level || values.includes(value));
  return <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label={label}>
    {EFFORTS.map((level) => {
      const on = values.includes(level);
      return <button key={level} type="button" aria-pressed={on} disabled={disabled} {...{ [dataAttr]: level }}
        onClick={() => onChange(on ? values.filter((value) => value !== level) : add(level))}
        className={`h-7 rounded-md border px-1.5 text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-selected-ink disabled:opacity-50 ${on
          ? 'border-hairline-strong bg-panel font-medium text-ink shadow-[var(--kiki-sheet-shadow)]'
          : 'border-transparent text-ink-soft hover:bg-ink/[0.04] hover:text-ink'}`}>{effortLabel(level, t)}</button>;
    })}
    {any && values.length === 0 ? <span className="pl-1 text-[11.5px] text-ink-faint">{t('st.profiles.ruleAny')}</span> : null}
  </div>;
}
