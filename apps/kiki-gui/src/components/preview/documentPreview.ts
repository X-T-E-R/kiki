/**
 * Document preview: one page, sheet or text window of a real file, rendered by
 * the server from bytes it already holds.
 *
 * Three rules shape this view.
 *
 * Fidelity is stated, never implied. `ready` means the server rendered the
 * layout; `text` means it returned the file's own characters, which is not the
 * same as showing the document, and the view says so. A summary is never
 * substituted for a page.
 *
 * Recovery is here, once. A missing renderer names the exact thing to install
 * and reuses this home's Work setup, so the user is not sent through a second
 * flow to get a preview working.
 *
 * The bytes never leave the machine. Assets come back through the same
 * session-scoped route that rendered them; the GUI never hands a local path to
 * an external viewer or a remote renderer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DocumentPreviewRequest, DocumentPreviewResponse, DocumentPreviewSource } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';

export type DocumentPreviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly response: DocumentPreviewResponse };

/**
 * Where the bytes come from. A workspace path and a session attachment are
 * different sources with different ids: a `file_id` means nothing to the
 * workspace renderer and a path means nothing to the media store, so neither
 * is ever substituted for the other.
 */
export function documentSourceFor(
  input:
    | { readonly path: string; readonly runtimeId?: string }
    | { readonly fileId: string; readonly name?: string; readonly mediaType?: string },
): DocumentPreviewSource {
  return 'fileId' in input
    ? { kind: 'session-media', file_id: input.fileId, name: input.name, media_type: input.mediaType }
    : { kind: 'workspace', path: input.path, runtime_id: input.runtimeId };
}

/** The page/sheet navigation of a rendered answer, when it has one. */
export function navigationOf(response: DocumentPreviewResponse): Extract<DocumentPreviewResponse, { kind: 'ready' }>['navigation'] | undefined {
  return response.kind === 'ready' ? response.navigation : undefined;
}

/** Sheet names, when the server listed them; `page`-only answers have none. */
export function sheetsOf(response: DocumentPreviewResponse): readonly string[] {
  if (response.kind !== 'ready' || response.navigation.kind !== 'sheet') return [];
  const listed = (response.navigation as { readonly sheets?: readonly string[] }).sheets;
  if (listed !== undefined) return listed;
  return response.navigation.sheet === undefined ? [] : [response.navigation.sheet];
}

/** True when the answer shows real layout rather than the file's own text. */
export function isRenderedFidelity(response: DocumentPreviewResponse): boolean {
  return response.kind === 'ready' && response.fidelity === 'rendered';
}

/** The single recovery action a blocked preview offers, if there is one. */
export function recoveryOf(response: DocumentPreviewResponse): Extract<DocumentPreviewResponse, { kind: 'missing_dependency' }>['recovery'] | undefined {
  return response.kind === 'missing_dependency' ? response.recovery : undefined;
}

export interface DocumentPreviewController {
  readonly state: DocumentPreviewState;
  readonly page?: number;
  readonly sheet?: string;
  /** Go to a page, or to a named sheet. Clears the other cursor. */
  readonly goTo: (next: { page?: number; sheet?: string; range?: string; offset?: number }) => void;
  /** Move within the current axis, clamped to what is actually known. */
  readonly step: (delta: number) => void;
  /**
   * The document's real page count, when the client learned it. A PDF page
   * count only exists once the file is open, so it arrives from the renderer
   * rather than from the preview answer.
   */
  readonly numPages?: number;
  readonly setNumPages: (count: number) => void;
  readonly canStepBack: boolean;
  readonly canStepForward: boolean;
  readonly retry: () => void;
}

export function useDocumentPreview(
  client: KikiClient | undefined,
  sessionId: string | undefined,
  source: DocumentPreviewSource | undefined,
  initial: { page?: number; sheet?: string } = {},
): DocumentPreviewController {
  const { locale } = useI18n();
  const [state, setState] = useState<DocumentPreviewState>({ kind: 'loading' });
  const [cursor, setCursor] = useState<{ page?: number; sheet?: string; range?: string; offset?: number }>(initial);
  const [attempt, setAttempt] = useState(0);
  const [numPages, setNumPages] = useState<number | undefined>(undefined);

  // The source is rebuilt on every parent render; keying the effect on its
  // contents keeps one fetch per actual source instead of one per render.
  const sourceKey = useMemo(() => (source === undefined ? undefined : JSON.stringify(source)), [source]);

  useEffect(() => { setNumPages(undefined); }, [sourceKey]);

  useEffect(() => {
    if (client === undefined || sessionId === undefined || source === undefined) {
      setState({
        kind: 'failed',
        message: locale === 'zh' ? '没有连接到这台电脑上的服务。' : 'Not connected to the service on this machine.',
      });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    const request: DocumentPreviewRequest = {
      source,
      page: cursor.page,
      sheet: cursor.sheet,
      range: cursor.range,
      offset: cursor.offset,
    };
    client.documentPreview(sessionId, request).then((response) => {
      if (!cancelled) setState({ kind: 'ready', response });
    }, (error: unknown) => {
      if (cancelled) return;
      setState({ kind: 'failed', message: errorText(locale, error) });
    });
    return () => { cancelled = true; };
  }, [attempt, client, cursor.offset, cursor.page, cursor.range, cursor.sheet, locale, sessionId, source, sourceKey]);

  const goTo = useCallback((next: { page?: number; sheet?: string; range?: string; offset?: number }) => {
    setCursor((previous) => ({ ...previous, ...next }));
  }, []);

  const bounds = useMemo(() => {
    if (state.kind !== 'ready') return { back: false, forward: false };
    const nav = navigationOf(state.response);
    if (nav?.kind === 'page') {
      const count = nav.page_count ?? numPages;
      return { back: (nav.page ?? 1) > 1, forward: count === undefined ? false : (nav.page ?? 1) < count };
    }
    if (nav?.kind === 'sheet') {
      const sheets = sheetsOf(state.response);
      const index = Math.max(0, sheets.findIndex((entry) => entry === nav.sheet));
      return { back: index > 0, forward: sheets.length === 0 ? false : index < sheets.length - 1 };
    }
    return { back: false, forward: false };
  }, [numPages, state]);

  const step = useCallback((delta: number) => {
    setState((current) => {
      if (current.kind !== 'ready') return current;
      const nav = navigationOf(current.response);
      if (nav?.kind === 'page') {
        const next = (nav.page ?? 1) + delta;
        if (next < 1) return current;
        const count = nav.page_count ?? numPages;
        if (count !== undefined && next > count) return current;
        setCursor((previous) => ({ ...previous, page: next, sheet: undefined, range: undefined }));
      } else if (nav?.kind === 'sheet') {
        const sheets = sheetsOf(current.response);
        const index = Math.max(0, sheets.findIndex((entry) => entry === nav.sheet));
        const next = Math.min(sheets.length - 1, Math.max(0, index + delta));
        if (sheets[next] === undefined) return current;
        setCursor((previous) => ({ ...previous, sheet: sheets[next], page: undefined, range: undefined }));
      }
      return current;
    });
  }, [numPages]);

  const retry = useCallback(() => { setAttempt((value) => value + 1); }, []);

  return { state, page: cursor.page, sheet: cursor.sheet, goTo, step, canStepBack: bounds.back, canStepForward: bounds.forward, numPages, setNumPages, retry };
}
