/**
 * Shared Tailwind class strings for settings chrome — one source so the
 * settings page, dialogs, chips, and banners stay on the same visual tokens.
 */

/**
 * The input's shape without a width. Pair it with an explicit width
 * (`w-24`, `w-64`): `INPUT` carries `w-full`, which wins the cascade over a
 * second width class whatever the order in the attribute.
 */
export const INPUT_BOX =
  'rounded-lg border border-hairline bg-paper px-3 py-2 text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint';

export const INPUT = `w-full ${INPUT_BOX}`;

export const SMALL_INPUT =
  'rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint';

export const PRIMARY_BUTTON =
  // Disabled is neutral, never a washed-out accent: orange only when pressing does something.
  // `text-on-accent` rather than `text-white`: the lifted dark accent is a
  // light orange, where white lands at 2.5:1.
  'rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-faint';

export const SECONDARY_BUTTON =
  'rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

export const DANGER_BUTTON =
  'rounded-md bg-danger px-3 py-1.5 text-[12px] font-semibold text-on-danger transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50';

export const DANGER_GHOST_BUTTON =
  'rounded-md border border-danger/40 bg-paper px-3 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/5 disabled:cursor-not-allowed disabled:opacity-50';
