/** The space's color mark: a small filled dot, or a hollow ring for no color. */
export function SpaceDot({ color, size = 8, className = '' }: { color?: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      data-space-dot
      className={`inline-block shrink-0 rounded-full ${color === undefined ? 'border border-ink-faint/70' : ''} ${className}`}
      style={{ width: size, height: size, ...(color === undefined ? {} : { backgroundColor: color }) }}
    />
  );
}
