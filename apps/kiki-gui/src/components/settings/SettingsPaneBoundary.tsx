import { Component, type ErrorInfo, type ReactNode } from 'react';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { SECONDARY_BUTTON } from '../ui';

interface BoundaryProps {
  readonly children: ReactNode;
  readonly resetKey: string;
  readonly title: string;
  readonly retryLabel: string;
  readonly copyLabel: string;
  readonly copiedLabel: string;
  readonly copyErrorText: (reason: string) => string;
}

interface BoundaryState {
  readonly error: Error | null;
  readonly resetKey: string;
  readonly copied: boolean;
  readonly copyError: string | null;
}

class SettingsPaneBoundaryView extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, resetKey: this.props.resetKey, copied: false, copyError: null };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)), copied: false, copyError: null };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey, copied: false, copyError: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[settings:pane-error]', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error, copied, copyError, resetKey } = this.state;
    if (error === null) return this.props.children;
    const summary = error.message.trim() || error.name;
    return (
      <section role="alert" data-settings-pane-error className="space-y-3 py-2">
        <h2 className="font-display text-[18px] leading-6 text-ink">{this.props.title}</h2>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[12px] leading-relaxed text-danger">
          {summary}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-settings-pane-retry className={SECONDARY_BUTTON}
            onClick={() => { this.setState({ error: null, copied: false, copyError: null }); }}>
            {this.props.retryLabel}
          </button>
          <button type="button" data-settings-pane-copy data-copied={copied ? 'true' : undefined} className={SECONDARY_BUTTON}
            onClick={() => {
              this.setState({ copied: false, copyError: null });
              void copyTextToClipboard(summary).then(
                () => { this.setState((state) => state.error === error && state.resetKey === resetKey ? { copied: true, copyError: null } : null); },
                (failure: unknown) => { this.setState((state) => state.error === error && state.resetKey === resetKey
                  ? { copied: false, copyError: this.props.copyErrorText(failure instanceof Error ? failure.message : String(failure)) } : null); },
              );
            }}>
            {copied ? this.props.copiedLabel : this.props.copyLabel}
          </button>
        </div>
        {copyError !== null ? <p role="status" data-settings-pane-copy-error className="text-[12px] text-danger">{copyError}</p> : null}
      </section>
    );
  }
}

/**
 * Catches a render failure inside one settings page so the navigation, the
 * search and every other page keep working. The page remounts on Retry, and
 * by itself as soon as the reader moves to another page (`resetKey`). Query
 * failures are not this: those already show an inline error and retry where
 * they happen.
 */
export function SettingsPaneBoundary({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <SettingsPaneBoundaryView
      resetKey={resetKey}
      title={t('app.unexpectedError')}
      retryLabel={t('common.retry')}
      copyLabel={t('contextMenu.copy')}
      copiedLabel={t('cb.copied')}
      copyErrorText={(reason) => t('st.remote.copyFailed', { reason })}
    >
      {children}
    </SettingsPaneBoundaryView>
  );
}
