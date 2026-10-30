import type { ReactNode } from 'react';

/**
 * "Where do I get this?" for a setup form: a few short numbered steps and,
 * when there is one, the official page that hands out the credential. It sits
 * directly above the fields it explains, in the form's own words, so the
 * reader never has to leave the panel to learn what a field wants.
 */
export function SetupSteps({ steps, link, data }: {
  readonly steps: readonly ReactNode[];
  readonly link?: { readonly href: string; readonly label: string };
  readonly data?: Record<`data-${string}`, string | undefined>;
}) {
  if (steps.length === 0 && link === undefined) return null;
  return (
    <div {...data} data-setup-steps className="space-y-1.5">
      {steps.length === 1 ? (
        // A one-step "list" reads as a broken enumeration; it is a sentence.
        <p className="text-[12.5px] leading-5 text-ink-soft">{steps[0]}</p>
      ) : steps.length > 1 ? (
        <ol className="space-y-1 text-[12.5px] leading-5 text-ink-soft">
          {steps.map((step, index) => (
            <li key={index} className="flex gap-2">
              <span aria-hidden className="w-4 shrink-0 text-right tabular-nums text-ink-faint">{index + 1}.</span>
              <span className="min-w-0">{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {link !== undefined ? (
        <a href={link.href} target="_blank" rel="noreferrer" data-setup-link
          className="inline-block pl-6 text-[12.5px] text-selected-ink underline-offset-2 hover:underline">
          {link.label} ↗
        </a>
      ) : null}
    </div>
  );
}
