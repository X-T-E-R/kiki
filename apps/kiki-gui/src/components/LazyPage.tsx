/**
 * Route pages that are downloaded on first visit, and the page-area boundary
 * that reports a failed download.
 *
 * Phones load the served GUI over the network, so pages a conversation never
 * shows (Settings, Usage, Memory, …) stay out of the first-paint graph. Their
 * download can fail: an offline phone, or a tab left open across a server
 * upgrade — `kiki web` serves hashed asset names, and the upgrade replaces
 * them, so an old page chunk answers 404. That failure stays inside the page
 * area, where the sidebar and every page already loaded remain usable, instead
 * of replacing the whole app with the error screen.
 */

import { Component, createElement, lazy, type ComponentType, type ReactNode } from 'react';

import { PRIMARY_BUTTON } from './ui';

/** A page module that could not be downloaded or evaluated. */
class PageLoadError extends Error {
  override readonly name = 'PageLoadError';
}

export type LazyPage<P extends object> = ComponentType<P> & {
  /** Start the download ahead of the visit. A failure is left for the visit to report. */
  preload(): void;
};

export function lazyPage<P extends object>(load: () => Promise<ComponentType<P>>): LazyPage<P> {
  const Lazy = lazy(() => load().then(
    (page) => ({ default: page }),
    (error: unknown) => { throw new PageLoadError(error instanceof Error ? error.message : String(error), { cause: error }); },
  ));
  const Page = (props: P) => createElement(Lazy as ComponentType<P>, props);
  Page.preload = () => { void load().catch(() => {}); };
  return Page;
}

interface PageLoadBoundaryProps {
  /** Leaving the failed address clears the failure, so the next page renders normally. */
  readonly resetKey: string;
  /** The page chrome shown above the failure, so a phone can still open the sidebar. */
  readonly header: ReactNode;
  readonly reloadLabel: string;
  readonly children: ReactNode;
}

interface PageLoadBoundaryState {
  readonly error: unknown;
  readonly resetKey: string;
}

/**
 * Catches a page download failure in the routed page area. Any other error is
 * rethrown, so a page that crashes while rendering still reaches
 * `AppErrorBoundary` exactly as before.
 *
 * The only action is a reload. Browsers remember a failed module URL for the
 * life of the document (Chromium answers a second `import()` of it without a
 * request), so retrying in place cannot succeed; a reload also fetches the
 * current index.html, which names the chunks an upgraded server really has.
 */
export class PageLoadBoundary extends Component<PageLoadBoundaryProps, PageLoadBoundaryState> {
  override state: PageLoadBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<PageLoadBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: PageLoadBoundaryProps, state: PageLoadBoundaryState): Partial<PageLoadBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!(error instanceof PageLoadError)) throw error;
    return (
      <>
        {this.props.header}
        <div role="alert" className="flex flex-col items-start gap-3 px-4 py-6 lg:px-6">
          <p className="max-w-full break-words font-mono text-[11px] text-ink-faint">{error.message}</p>
          <button type="button" className={PRIMARY_BUTTON} onClick={() => { window.location.reload(); }}>
            {this.props.reloadLabel}
          </button>
        </div>
      </>
    );
  }
}
