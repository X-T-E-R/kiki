import { ChevronDown } from 'lucide-react';

interface SpacePillProps {
  readonly label: string;
  readonly statusTone: 'online' | 'attention' | 'offline';
  readonly onClick: () => void;
}

export function SpacePill({ label, statusTone, onClick }: SpacePillProps) {
  const dotClass =
    statusTone === 'attention'
      ? 'bg-accent'
      : statusTone === 'online'
        ? 'bg-success'
        : 'border border-ink-faint bg-transparent';

  return (
    <button
      type="button"
      data-mobile-space-pill
      onClick={onClick}
      className="inline-flex min-h-11 max-w-[230px] items-center gap-2 rounded-full border border-hairline bg-panel px-3.5 text-[13.5px] font-normal text-ink shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.04)] transition-colors hover:border-hairline-strong active:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink"
    >
      <span aria-hidden="true" className={`h-[7px] w-[7px] shrink-0 rounded-full ${dotClass}`} />
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
