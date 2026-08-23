import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useI18n } from '../i18n';

interface BoundaryProps {
  readonly children: ReactNode;
  readonly title: string;
  readonly reloadLabel: string;
}

interface BoundaryState {
  readonly error: Error | null;
}

class AppErrorBoundaryView extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app:error-boundary]', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const summary = error.message.trim() || error.name;
    return (
      <main className="flex h-full min-h-screen items-center justify-center bg-paper px-4 text-ink">
        <section
          role="alert"
          className="w-full max-w-[520px] rounded-xl border border-hairline bg-panel px-7 py-6 shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_32px_-16px_rgba(28,25,23,0.12)]"
        >
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            {this.props.title}
          </h1>
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[12px] leading-relaxed text-danger">
            {summary}
          </pre>
          <button
            type="button"
            onClick={() => { window.location.reload(); }}
            className="mt-5 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-accent-deep"
          >
            {this.props.reloadLabel}
          </button>
        </section>
      </main>
    );
  }
}

export function AppErrorBoundary({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  return (
    <AppErrorBoundaryView
      title={t('app.unexpectedError')}
      reloadLabel={t('app.reload')}
    >
      {children}
    </AppErrorBoundaryView>
  );
}
