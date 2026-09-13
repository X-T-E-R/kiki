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
 * No new colors or tokens: everything below composes the existing hairline /
 * ink / accent scale and the shared `Hint` help line.
 */

import { Hint, Toggle } from '../controls';

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
    <div className="space-y-2" data-settings-group>
      <div>
        <p className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">{title}</p>
        {help !== undefined ? <Hint>{help}</Hint> : null}
      </div>
      <div className="space-y-3">{children}</div>
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
  help,
  layout = 'row',
  children,
}: {
  label: string;
  /** Set when the control is a real form element, so the label activates it. */
  htmlFor?: string;
  /** Plain language: what changing this does, and what the default is. */
  help?: string;
  layout?: 'row' | 'stack';
  children: React.ReactNode;
}) {
  const labelClass = 'text-[12.5px] font-medium text-ink';
  const labelNode = htmlFor === undefined
    ? <span className={labelClass}>{label}</span>
    : <label htmlFor={htmlFor} className={labelClass}>{label}</label>;

  return (
    <div className="space-y-1" data-settings-field>
      {layout === 'row' ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          {labelNode}
          <div className="flex flex-wrap items-center gap-2">{children}</div>
        </div>
      ) : (
        <>
          {labelNode}
          <div className="space-y-1">{children}</div>
        </>
      )}
      {help !== undefined ? <Hint>{help}</Hint> : null}
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-0.5" data-settings-actions>
      {children}
    </div>
  );
}
