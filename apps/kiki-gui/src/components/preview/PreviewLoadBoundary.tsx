/**
 * Lazy-loaded preview surfaces (PreviewWorkspace and MediaLightbox) and the
 * localized chunk-download boundary that keeps a failed asset fetch inside the
 * preview panel or lightbox layer instead of taking down the whole app.
 *
 * Mirrors `LazyPage.tsx`: browsers remember a failed dynamic `import()` URL for
 * the life of the document, so the only truthful recovery is `location.reload()`,
 * which also fetches the current `index.html` after a server upgrade.
 */

import { Component, createElement, lazy, useEffect, useState, type ComponentType, type ReactNode } from 'react';

import { useI18n } from '#/i18n';
import { Dialog } from '../Dialog';
import { Icon } from '../icons';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';

/** A preview or lightbox module that could not be downloaded or evaluated. */
export class PreviewLoadError extends Error {
  override readonly name = 'PreviewLoadError';
}

export type LazyPreviewComponent<P extends object> = ComponentType<P> & {
  preload(): Promise<void>;
  /** Test-only override to simulate a failed or replace-loaded chunk. */
  setLoaderForTest(override?: () => Promise<ComponentType<P>>): void;
};

export function lazyPreviewComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
): LazyPreviewComponent<P> {
  let activeLoad = load;
  let resolved: ComponentType<P> | undefined;
  let pending: Promise<{ default: ComponentType<P> }> | undefined;
  let lazyComponent: ComponentType<P> | undefined;
  const ensure = () => {
    pending ??= activeLoad().then(
      (component) => {
        resolved = component;
        return { default: component };
      },
      (error: unknown) => {
        throw new PreviewLoadError(error instanceof Error ? error.message : String(error), { cause: error });
      },
    );
    return pending;
  };
  lazyComponent = lazy(ensure);
  const ComponentWrapper = (props: P) =>
    createElement((resolved ?? lazyComponent) as ComponentType<P>, props);
  ComponentWrapper.preload = () => ensure().then(() => undefined, () => undefined);
  ComponentWrapper.setLoaderForTest = (override?: () => Promise<ComponentType<P>>) => {
    activeLoad = override ?? load;
    resolved = undefined;
    pending = undefined;
    lazyComponent = lazy(ensure);
  };
  return ComponentWrapper;
}

interface PreviewLoadBoundaryProps {
  readonly resetKey: string;
  readonly renderFailure: (error: PreviewLoadError) => ReactNode;
  readonly children: ReactNode;
}

interface PreviewLoadBoundaryState {
  readonly error: unknown;
  readonly resetKey: string;
}

export class PreviewLoadBoundary extends Component<PreviewLoadBoundaryProps, PreviewLoadBoundaryState> {
  override state: PreviewLoadBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<PreviewLoadBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: PreviewLoadBoundaryProps,
    state: PreviewLoadBoundaryState,
  ): Partial<PreviewLoadBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!(error instanceof PreviewLoadError)) {
      throw error instanceof Error ? error : new Error('Preview failed to render', { cause: error });
    }
    return this.props.renderFailure(error);
  }
}

function QuietReadingLine() {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setShown(true);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, []);
  if (!shown) return null;
  return (
    <p className="flex items-center gap-2 p-4 text-[12px] text-ink-faint" data-preview-reading>
      <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
      {t('preview.reading')}
    </p>
  );
}

export function PreviewPanelLoadingShell({
  width,
  hidden = false,
  overlay = false,
}: {
  readonly width: number;
  readonly hidden?: boolean;
  readonly overlay?: boolean;
}) {
  const { t } = useI18n();
  return (
    <aside
      data-preview-workspace
      data-preview-chunk-loading
      hidden={hidden}
      aria-busy="true"
      aria-label={t('preview.title')}
      className={`preview-workspace ${overlay ? 'preview-workspace--overlay' : ''}`}
      style={hidden ? { display: 'none' } : { width }}
    >
      <QuietReadingLine />
    </aside>
  );
}

export function PreviewPanelLoadFailure({
  error,
  width,
  hidden = false,
  overlay = false,
  onCollapse,
}: {
  readonly error: PreviewLoadError;
  readonly width: number;
  readonly hidden?: boolean;
  readonly overlay?: boolean;
  readonly onCollapse: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside
      data-preview-workspace
      data-preview-load-failed
      hidden={hidden}
      aria-label={t('preview.title')}
      className={`preview-workspace ${overlay ? 'preview-workspace--overlay' : ''}`}
      style={hidden ? { display: 'none' } : { width }}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-hairline px-3">
        <span className="truncate text-[13px] font-medium text-ink">{t('preview.title')}</span>
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={onCollapse}
          className="flex h-11 w-11 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-paper hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div role="alert" className="flex flex-1 flex-col items-start gap-3 p-4">
        <p className="text-[13px] text-ink-soft">{t('preview.loadFailed')}</p>
        {error.message !== '' ? (
          <p className="max-w-full break-words font-mono text-[11px] text-ink-faint">{error.message}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-preview-chunk-reload
            className={PRIMARY_BUTTON}
            onClick={() => {
              window.location.reload();
            }}
          >
            {t('app.reload')}
          </button>
        </div>
      </div>
    </aside>
  );
}

export function LightboxLoadingShell({
  label,
  onClose,
}: {
  readonly label: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      onClose={onClose}
      ariaLabel={label}
      overlayId="media-lightbox"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-shell/85 p-4 pt-[max(1rem,var(--kiki-safe-top-inset))] pb-[max(1rem,var(--kiki-safe-bottom-inset))]"
      panelClassName="anim-enter flex max-h-full w-full max-w-[94vw] flex-col items-center gap-3 outline-none"
    >
      <div className="flex w-full max-w-full items-center justify-end">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="rounded-full border border-shell-hairline bg-shell-hover px-3 py-1 text-[11.5px] font-medium text-shell-ink transition-colors hover:bg-shell-hover"
        >
          <Icon name="close" />
        </button>
      </div>
      <div aria-busy="true" className="flex min-h-48 items-center justify-center text-sm text-shell-ink">
        {t('preview.loading')}
      </div>
    </Dialog>
  );
}

export function LightboxLoadFailure({
  error,
  label,
  onClose,
}: {
  readonly error: PreviewLoadError;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      onClose={onClose}
      ariaLabel={label}
      overlayId="media-lightbox"
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-shell/85 p-4 pt-[max(1rem,var(--kiki-safe-top-inset))] pb-[max(1rem,var(--kiki-safe-bottom-inset))]"
      panelClassName="anim-enter flex max-h-full w-full max-w-[520px] flex-col items-start gap-3 rounded-2xl border border-hairline bg-panel p-5 outline-none"
    >
      <div role="alert" data-lightbox-load-failed className="flex w-full flex-col items-start gap-3">
        <p className="text-[13px] font-medium text-ink">{t('preview.loadFailed')}</p>
        {error.message !== '' ? (
          <p className="max-w-full break-words font-mono text-[11px] text-ink-faint">{error.message}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-preview-chunk-reload
            className={PRIMARY_BUTTON}
            onClick={() => {
              window.location.reload();
            }}
          >
            {t('app.reload')}
          </button>
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export const LazyPreviewWorkspace = lazyPreviewComponent(() =>
  import('../PreviewWorkspace').then((module) => module.PreviewWorkspace),
);

export const LazyMediaLightbox = lazyPreviewComponent(() =>
  import('../MediaLightbox').then((module) => module.MediaLightbox),
);
