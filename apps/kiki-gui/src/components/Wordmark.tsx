/** The kiki wordmark: lowercase Fraunces with a small accent dot. */

export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const textClass = size === 'lg' ? 'text-4xl' : 'text-[22px]';
  const dotClass = size === 'lg' ? 'h-2 w-2' : 'h-1.5 w-1.5';
  return (
    <span className="inline-flex items-baseline select-none" aria-label="kiki">
      <span
        className={`font-display ${textClass} leading-none font-semibold tracking-tight text-ink`}
        style={{ fontVariationSettings: '"opsz" 40' }}
      >
        kiki
      </span>
      <span className={`${dotClass} ml-[3px] translate-y-[-1px] rounded-full bg-accent`} />
    </span>
  );
}

/** Small accent square used as the assistant's inline mark. */
export function KikiMark({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 rounded-[3px] bg-accent ${className}`}
    />
  );
}
