/**
 * Shared interior layout for settings cards.
 *
 * `SectionCard` gives a page its outer rhythm (rule + quiet heading). These
 * primitives give the *inside* of a card the same rhythm on every page, so a
 * control reads the same way in Tasks as it does in MCP:
 *
 *   SettingsGroup   labelled sub-step, ordered by decision flow
 *   SettingField    one decision: label, control, then a plain-language help line
 *   DependentField  a control that only matters once something else is on
 *   AdvancedDetails collapsed tail of a card — background, diagnostics, policy text
 *   CardActions     the save/verify row, always last and always aligned the same
 *
 * `help` is the first-screen line and `detail` is the same field's on-demand
 * text, so one field can carry both without paying for the second on everyone.
 *
 * No new colors or tokens: everything below composes the existing hairline /
 * ink / accent scale and the shared `Hint` help line.
 */

import { Hint } from '../controls';
import { SettingHelp } from './SettingHelp';

/**
 * A labelled step inside a card. Cards use these top-to-bottom in the order a
 * person actually decides things — the choice that constrains the others first.
 */
export function SettingsGroup({
  title,
  help,
  children,
}: {
  title: string;
  /** One line on what this whole group is for, when the title is not enough. */
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2 border-t border-hairline pt-5 first:border-t-0 first:pt-0" data-settings-group>
      <div>
        <p className="text-[13px] font-medium text-ink">{title}</p>
        {help !== undefined ? <Hint>{help}</Hint> : null}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/**
 * One setting. `layout="row"` keeps compact controls (select, toggle, pill
 * group) on the heading line; `layout="stack"` is for controls that need the
 * full width (paths, textareas). Either way the help line lands in the same
 * place, so the eye learns one shape.
 */
export function SettingField({
  label,
  htmlFor,
  labelId,
  help,
  detail,
  layout = 'row',
  children,
}: {
  label: string;
  /** Set when the control is a real form element, so the label activates it. */
  htmlFor?: string;
  /** Id on the label text, for `aria-labelledby` on grouped controls. */
  labelId?: string;
  /** Plain language: what changing this does, and what the default is. */
  help?: React.ReactNode;
  /**
   * Read on demand behind the label's `i`, the same slot `NumberField.detail`
   * uses. `help` is what a reader needs before choosing; `detail` is the
   * consequence, the entitlement or the inheritance rule they ask for once
   * the choice is in front of them.
   */
  detail?: React.ReactNode;
  layout?: 'row' | 'stack';
  children: React.ReactNode;
}) {
  // T3/400: a field label is a row, not a heading. 500 is reserved for the
  // sub-block titles above (SettingsGroup) so the two never read alike.
  const labelClass = 'text-[13px] text-ink';
  const labelNode = htmlFor === undefined
    ? <span id={labelId} className={labelClass}>{label}</span>
    : <label id={labelId} htmlFor={htmlFor} className={labelClass}>{label}</label>;
  // The `i` rides the label's own line, so a field that carries one reads as
  // one label with a footnote rather than a label and a second row of text.
  const headingNode = detail === undefined || detail === null
    ? labelNode
    : <div className="flex items-center gap-1.5">{labelNode}<SettingHelp>{detail}</SettingHelp></div>;
  const helpNode = help !== undefined && help !== null ? <Hint>{help}</Hint> : null;

  // Row: label and its help on the left, control on the right edge. Below
  // `sm` the control drops under the text so nothing is squeezed.
  return layout === 'row' ? (
    <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6" data-settings-field>
      <div className="min-w-0 space-y-0.5 sm:pt-1.5 sm:leading-5">{headingNode}{helpNode}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  ) : (
    <div className="space-y-1.5 py-1" data-settings-field>
      {headingNode}
      <div className="space-y-1">{children}</div>
      {helpNode}
    </div>
  );
}

/**
 * A setting that only has meaning while some other setting is on. Rendering
 * `null` instead of a disabled input is the point: an inert field still reads
 * as a decision the user has to make, and it is not one.
 */
export function DependentField({
  when,
  children,
}: {
  when: boolean;
  children: React.ReactNode;
}) {
  if (!when) return null;
  return (
    <div className="border-l-2 border-hairline pl-3" data-settings-dependent>
      {children}
    </div>
  );
}

/**
 * Collapsed tail of a card: reference text, resolution rules, raw ids. Present
 * for the person who needs it, costing one line for everyone who does not.
 */
export function AdvancedDetails({
  summary,
  children,
  ...rest
}: {
  summary: string;
  children: React.ReactNode;
} & React.DetailsHTMLAttributes<HTMLDetailsElement>) {
  return (
    <details className="text-[11px] text-ink-soft" {...rest}>
      <summary className="cursor-pointer select-none font-medium text-ink-soft hover:text-ink">
        {summary}
      </summary>
      <div className="mt-1.5 space-y-1.5 leading-relaxed">{children}</div>
    </details>
  );
}

/**
 * The commit row. Buttons first, then status and saved affirmations, so "what
 * do I press" sits in the same spot on every card.
 */
export function CardActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 pt-3" data-settings-actions>
      {children}
    </div>
  );
}
