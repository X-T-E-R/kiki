import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Shared dock column axis (`px-3 sm:px-6` outer gutter + `--kiki-chat-content-width`
 * centered column) so strips, recovery bars, branch controls, and notices above
 * `<Composer />` align pixel-for-pixel with the transcript and composer card.
 */
export function ConversationDockColumn({
  children,
  className,
  innerClassName,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  readonly children: ReactNode;
  readonly innerClassName?: string;
}) {
  return (
    <div
      className={className === undefined ? 'px-3 sm:px-6' : `px-3 sm:px-6 ${className}`}
      {...rest}
    >
      <div
        className={
          innerClassName === undefined
            ? 'mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)]'
            : `mx-auto w-full max-w-[var(--kiki-chat-content-width,760px)] ${innerClassName}`
        }
      >
        {children}
      </div>
    </div>
  );
}
