import { useThreadTitle } from '../lib/threadTitles';

/** Plain title text, safe inside row buttons and other non-link controls. */
export function ThreadTitle({ text }: { text: string }) {
  return <>{useThreadTitle(text)}</>;
}
