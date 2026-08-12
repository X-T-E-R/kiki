/**
 * Shared Tailwind class strings for settings chrome — one source so the
 * settings page, dialogs, chips, and banners stay on the same visual tokens.
 */

export const INPUT =
  'w-full rounded-lg border border-hairline bg-paper px-2.5 py-2 text-[12px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint';

export const SMALL_INPUT =
  'rounded-md border border-hairline bg-paper px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:bg-hairline/20 disabled:text-ink-faint';

export const PRIMARY_BUTTON =
  'rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50';

export const SECONDARY_BUTTON =
  'rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

export const DANGER_BUTTON =
  'rounded-md bg-danger px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50';

export const DANGER_GHOST_BUTTON =
  'rounded-md border border-danger/40 bg-paper px-3 py-1.5 text-[12px] text-danger transition-colors hover:bg-danger/5 disabled:cursor-not-allowed disabled:opacity-50';
