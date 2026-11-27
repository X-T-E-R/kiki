import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import { basenameOf, resolveHostPath } from '@kiki/session-core/composer/media';
import type { AgentForest, SessionController, SessionViewState } from '@kiki/session-core/session';
import type { HostSaveSink } from '../host/host';
import { useI18n } from '../i18n';
import { lazyComponent } from '../lib/lazyComponent';
import { anyOverlayOpen } from '../lib/uiBusy';
import { useOptionalConnection } from '../state/connection';
import type { PreviewTabsState } from '../state/previewWorkspace';
import type { PreviewWorkspaceProps } from './PreviewWorkspace';
import type { AgentWorkspaceNavigation } from './agent-workspace';
import { httpImageLink, mediaOutcomeKey, resolveImageMime } from './imageActions';
import { imagePreviewLabel, safeImagePreviewName } from './imagePreviewName';
import type { GalleryImage } from './mediaGallery';
import type { AnnotationRecord, MediaLightboxThumbnail } from './MediaLightbox';
import { useSessionMedia } from './mediaParts';
import { useMediaPreview } from './mediaPreviewContext';
import {
  LazyMediaLightbox,
  LazyPreviewWorkspace,
  LightboxLoadFailure,
  LightboxLoadingShell,
  PreviewLoadBoundary,
  PreviewPanelLoadFailure,
  PreviewPanelLoadingShell,
} from './preview/PreviewLoadBoundary';

const ConfirmDialog = lazyComponent(() => import('./ConfirmDialog').then((m) => m.ConfirmDialog));

if (import.meta.env.MODE === 'test') {
  await ConfirmDialog.preload();
}

export type PreviewCloseAction =
  | { readonly kind: 'tab'; readonly key: string }
  | { readonly kind: 'others'; readonly key: string }
  | { readonly kind: 'all' };

export interface MediaPreviewOverlaysProps {
  readonly previewKey: string;
  readonly tabsState: PreviewTabsState;
  readonly navigation: PreviewWorkspaceProps['navigation'];
  readonly dirtyPaths: ReadonlySet<string>;
  readonly width: number;
  readonly panelHidden: boolean;
  readonly panelOverlay: boolean;
  readonly phoneMode: boolean;
  readonly effectiveMaximized: boolean;
  readonly togglePreviewMaximized: () => void;
  readonly exitPreviewMaximized: () => void;
  readonly sessionViewState?: SessionViewState;
  readonly agentForest?: AgentForest;
  readonly onOpenSubagent?: (agentId: string) => void;
  readonly controller?: SessionController | null;
  readonly workspaceNavigation?: AgentWorkspaceNavigation;
  readonly onCancelTask?: (taskId: string, ownerAgentId?: string) => void;
  readonly onStopAgentTask?: (ownerAgentId: string, taskId: string) => Promise<void>;
  readonly onActivate: (key: string) => void;
  readonly onRequestClose: (action: PreviewCloseAction) => void;
  readonly onMove: PreviewWorkspaceProps['onMove'];
  readonly collapsePanel: () => void;
  readonly onWidthChange: PreviewWorkspaceProps['onWidthChange'];
  readonly onOpenImage: (src: string, name?: string, sourcePath?: string) => void;
  readonly reportDirty: (path: string, dirty: boolean) => void;
  readonly positions: Readonly<Record<string, { top: number; left?: number }>>;
  readonly reportPosition: (key: string, position: { top: number; left?: number }) => void;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly renderDesktopPortal: (panel: ReactNode) => ReactNode;
  readonly confirmClose: { readonly dirty: readonly string[]; readonly action: PreviewCloseAction } | null;
  readonly confirmCloseRun: () => void;
  readonly onCancelConfirmClose: () => void;
  readonly activeGallery: {
    readonly images: readonly GalleryImage[];
    readonly selected: number;
    readonly targetAgentId?: string;
    readonly seededId?: string;
    readonly seededSrc?: string;
  } | null;
  readonly onSelectGallery: (selected: number) => void;
  readonly onCloseGallery: () => void;
  readonly activeImage: {
    readonly src: string;
    readonly name?: string;
    readonly sourcePath?: string;
    readonly targetAgentId?: string;
  } | null;
  readonly onCloseImage: () => void;
  readonly localKikiComputer: boolean;
  readonly lightboxAnnotations: Readonly<Record<string, AnnotationRecord>>;
  readonly setLightboxAnnotations: React.Dispatch<React.SetStateAction<Record<string, AnnotationRecord>>>;
  readonly attachAnnotatedImageFor: (targetAgentId?: string) => ((blob: Blob, filename: string) => Promise<boolean> | boolean) | undefined;
}

export function MediaPreviewOverlays({
  previewKey,
  tabsState,
  navigation,
  dirtyPaths,
  width,
  panelHidden,
  panelOverlay,
  phoneMode,
  effectiveMaximized,
  togglePreviewMaximized,
  exitPreviewMaximized,
  sessionViewState,
  agentForest,
  onOpenSubagent,
  controller,
  workspaceNavigation,
  onCancelTask,
  onStopAgentTask,
  onActivate,
  onRequestClose,
  onMove,
  collapsePanel,
  onWidthChange,
  onOpenImage,
  reportDirty,
  positions,
  reportPosition,
  cwd,
  sessionId,
  renderDesktopPortal,
  confirmClose,
  confirmCloseRun,
  onCancelConfirmClose,
  activeGallery,
  onSelectGallery,
  onCloseGallery,
  activeImage,
  onCloseImage,
  localKikiComputer,
  lightboxAnnotations,
  setLightboxAnnotations,
  attachAnnotatedImageFor,
}: MediaPreviewOverlaysProps) {
  const { t } = useI18n();
  const [drawerHostEl, setDrawerHostEl] = useState<HTMLDivElement | null>(null);

  const panel = tabsState.tabs.length > 0 ? (
    <PreviewLoadBoundary
      resetKey={previewKey}
      renderFailure={(error) => (
        <PreviewPanelLoadFailure
          error={error}
          width={width}
          hidden={panelHidden}
          overlay={panelOverlay}
          onCollapse={collapsePanel}
        />
      )}
    >
      <Suspense fallback={<PreviewPanelLoadingShell width={width} hidden={panelHidden} overlay={panelOverlay} />}>
        <LazyPreviewWorkspace
          tabs={tabsState.tabs}
          active={tabsState.active}
          navigation={navigation}
          dirtyPaths={dirtyPaths}
          width={width}
          hidden={panelHidden}
          isFullscreen={effectiveMaximized}
          onToggleFullscreen={togglePreviewMaximized}
          onExitFullscreen={exitPreviewMaximized}
          sessionViewState={sessionViewState}
          agentForest={agentForest}
          onOpenSubagent={onOpenSubagent}
          controller={controller}
          workspaceNavigation={workspaceNavigation}
          onCancelTask={onCancelTask}
          onStopAgentTask={onStopAgentTask}
          onActivate={onActivate}
          onClose={(key) => { onRequestClose({ kind: 'tab', key }); }}
          onCloseOthers={(key) => { onRequestClose({ kind: 'others', key }); }}
          onCloseAll={() => { onRequestClose({ kind: 'all' }); }}
          onMove={onMove}
          onCollapse={collapsePanel}
          onWidthChange={onWidthChange}
          onOpenImage={onOpenImage}
          reportDirty={reportDirty}
          scrollPositions={positions}
          onScrollPosition={reportPosition}
          overlay={panelOverlay}
          cwd={cwd}
          sessionId={sessionId}
        />
      </Suspense>
    </PreviewLoadBoundary>
  ) : null;

  const portalContainer =
    drawerHostEl !== null && drawerHostEl.closest('.kiki-drawer-indent') === null
      ? drawerHostEl
      : undefined;

  return (
    <>
      <div ref={setDrawerHostEl} className="contents" />
      {panel !== null && phoneMode && !panelHidden ? (
        <Drawer.Root
          open
          modal="trap-focus"
          onOpenChange={(nextOpen, eventDetails) => {
            if (!nextOpen && (eventDetails.reason === 'outside-press' || eventDetails.reason === 'escape-key') && anyOverlayOpen()) {
              eventDetails.cancel();
              return;
            }
            if (!nextOpen) collapsePanel();
          }}
          snapPoints={[0.92]}
          swipeDirection="down"
        >
          <Drawer.Portal container={portalContainer}>
            <Drawer.Backdrop className="kiki-drawer-backdrop" />
            <Drawer.Viewport className="kiki-drawer-viewport-bottom">
              <Drawer.Popup
                data-mobile-preview-sheet=""
                aria-label={t('preview.title')}
                className="kiki-drawer-bottom h-[94dvh] w-full max-w-full"
              >
                <div className="kiki-mobile-sheet-grabber" aria-hidden />
                <div className="min-h-0 flex-1 overflow-hidden">
                  {panel}
                </div>
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.Portal>
        </Drawer.Root>
      ) : panel !== null ? renderDesktopPortal(panel) : null}
      {confirmClose !== null ? (
        <ConfirmDialog
          open
          overlayId="preview-close-dirty"
          title={t('preview.discardTitle')}
          body={
            confirmClose.dirty.length === 1
              ? t('preview.discardBody', { name: basenameOf(confirmClose.dirty[0] ?? '') })
              : t('preview.discardBodyMany', { count: confirmClose.dirty.length })
          }
          confirmLabel={t('preview.discard')}
          tone="danger"
          onConfirm={confirmCloseRun}
          onCancel={onCancelConfirmClose}
        />
      ) : null}
      {activeGallery !== null && activeGallery.images[activeGallery.selected] !== undefined ? (
        <GalleryLightbox
          images={activeGallery.images}
          image={activeGallery.images[activeGallery.selected]!}
          sessionId={sessionId}
          localKikiComputer={localKikiComputer}
          seededSrc={activeGallery.seededId === activeGallery.images[activeGallery.selected]!.id ? activeGallery.seededSrc : undefined}
          index={activeGallery.selected}
          count={activeGallery.images.length}
          savedAnnotations={lightboxAnnotations}
          onAnnotationsChange={setLightboxAnnotations}
          onAttachAnnotatedImage={attachAnnotatedImageFor(activeGallery.targetAgentId)}
          onSelect={onSelectGallery}
          onClose={onCloseGallery}
        />
      ) : null}
      {activeImage !== null ? (
        <PreviewLoadBoundary
          resetKey={activeImage.src}
          renderFailure={(error) => (
            <LightboxLoadFailure
              error={error}
              label={imagePreviewLabel({ name: activeImage.name }, t('media.image'))}
              onClose={onCloseImage}
            />
          )}
        >
          <Suspense
            fallback={
              <LightboxLoadingShell
                label={imagePreviewLabel({ name: activeImage.name }, t('media.image'))}
                onClose={onCloseImage}
              />
            }
          >
            <LazyMediaLightbox
              src={activeImage.src}
              name={activeImage.name}
              sourcePath={activeImage.sourcePath}
              linkUrl={httpImageLink(activeImage.src)}
              outcomeKey={mediaOutcomeKey({ url: activeImage.src })}
              localKikiComputer={localKikiComputer}
              savedAnnotations={lightboxAnnotations}
              onAnnotationsChange={setLightboxAnnotations}
              onAttachAnnotatedImage={attachAnnotatedImageFor(activeImage.targetAgentId)}
              onClose={onCloseImage}
            />
          </Suspense>
        </PreviewLoadBoundary>
      ) : null}
    </>
  );
}

function useTypedImageUrl(bytes: Uint8Array | undefined, declared: string | undefined): string | undefined {
  const [typed, setTyped] = useState<{ readonly url: string }>();
  useEffect(() => {
    if (bytes === undefined) return;
    const mime = resolveImageMime(bytes, declared);
    if (mime === undefined || mime === declared) return;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setTyped({ url });
    return () => {
      URL.revokeObjectURL(url);
      setTyped((current) => current?.url === url ? undefined : current);
    };
  }, [bytes, declared]);
  return typed?.url;
}

function GalleryLightbox({
  images,
  image,
  sessionId,
  localKikiComputer = false,
  seededSrc,
  index,
  count,
  savedAnnotations,
  onAnnotationsChange,
  onAttachAnnotatedImage,
  onSelect,
  onClose,
}: {
  images: readonly GalleryImage[];
  image: GalleryImage;
  sessionId?: string;
  localKikiComputer?: boolean;
  seededSrc?: string;
  index: number;
  count: number;
  savedAnnotations?: Readonly<Record<string, AnnotationRecord>>;
  onAnnotationsChange?: (updater: (previous: Record<string, AnnotationRecord>) => Record<string, AnnotationRecord>) => void;
  onAttachAnnotatedImage?: (blob: Blob, filename: string) => Promise<boolean> | boolean;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const client = connection?.client;
  const preview = useMediaPreview();
  const hostPath = image.item.path === undefined ? undefined : resolveHostPath(image.item.path, preview?.cwd);
  const [retry, setRetry] = useState({ id: image.id, attempt: 0 });
  const hasCanonicalSource =
    (sessionId !== undefined && image.item.fileId !== undefined && typeof (client as { readSessionMediaBytes?: unknown } | undefined)?.readSessionMediaBytes === 'function') ||
    (hostPath !== undefined && typeof (client as { readHostFileBytes?: unknown } | undefined)?.readHostFileBytes === 'function');
  const retryAttempt = retry.id === image.id ? retry.attempt : 0;
  const load = useSessionMedia(image.item, sessionId, hasCanonicalSource, false, retryAttempt);
  const bytes = load.status === 'ready' ? load.bytes : undefined;
  const mime = bytes === undefined ? image.item.mime : resolveImageMime(bytes, load.status === 'ready' ? load.mime : image.item.mime) ?? image.item.mime;
  const typedSrc = useTypedImageUrl(bytes, load.status === 'ready' ? load.mime : undefined);
  const externalSeedSrc = hasCanonicalSource && seededSrc?.startsWith('blob:') === true ? undefined : seededSrc;
  const previewFallbackSrc = load.status === 'failed'
    ? undefined
    : (externalSeedSrc ?? (load.status !== 'ready' ? load.thumbnailUrl : undefined));
  const fullSrc = hasCanonicalSource
    ? (load.status === 'ready' ? (typedSrc ?? load.url) : undefined)
    : (externalSeedSrc ?? image.item.url);
  const src = fullSrc ?? previewFallbackSrc;
  const size = load.status === 'ready' ? load.bytes.byteLength : image.item.size;
  const isLoading = src === undefined && hasCanonicalSource && load.status === 'loading';
  const isFailed = src === undefined && hasCanonicalSource && load.status === 'failed';

  const onSaveOriginal = useMemo(() => {
    if (client === undefined || (hostPath === undefined && (sessionId === undefined || image.item.fileId === undefined))) return undefined;
    return async (sink: HostSaveSink, signal: AbortSignal, onProgress: (bytes: number, total?: number) => void) => {
      const consume: import('@kiki/klient').HttpRestMediaSink = async (chunk, progress) => {
        await sink.write(chunk);
        onProgress(progress.bytes, progress.totalBytes);
      };
      const options = { ...client.readingOptions(), signal };
      if (hostPath !== undefined) await client.downloadHostFile(hostPath, consume, options);
      else await client.downloadSessionMedia(sessionId!, image.item.fileId!, consume, options);
    };
  }, [client, sessionId, hostPath, image.item.fileId]);

  const thumbnails = useMemo<readonly MediaLightboxThumbnail[] | undefined>(
    () => (images.length > 1
      ? images.map((entry, entryIndex) => ({
          id: entry.occurrenceId ?? `${entry.id}:${entryIndex}`,
          src: entry.item.url,
          label: safeImagePreviewName({ name: entry.item.name, path: entry.item.path }),
        }))
      : undefined),
    [images],
  );

  const resolvedName = safeImagePreviewName({
    name: image.item.name,
    metadataName: load.status === 'ready' ? load.name : undefined,
    path: image.item.path,
  });
  const fallbackLabel = imagePreviewLabel({ name: resolvedName }, t('media.image'));

  return (
    <PreviewLoadBoundary
      resetKey={image.id}
      renderFailure={(error) => <LightboxLoadFailure error={error} label={fallbackLabel} onClose={onClose} />}
    >
      <Suspense fallback={<LightboxLoadingShell label={fallbackLabel} onClose={onClose} />}>
        <LazyMediaLightbox
          src={src}
          identity={image.id}
          name={resolvedName}
          sourcePath={hostPath}
          linkUrl={httpImageLink(image.item.url)}
          outcomeKey={mediaOutcomeKey({ ...image.item, sessionId })}
          localKikiComputer={localKikiComputer}
          mime={mime}
          size={size}
          loading={isLoading}
          failed={isFailed}
          onRetry={() => { setRetry((current) => ({ id: image.id, attempt: current.id === image.id ? current.attempt + 1 : 1 })); }}
          onSaveOriginal={onSaveOriginal}
          savedAnnotations={savedAnnotations}
          onAnnotationsChange={onAnnotationsChange}
          onAttachAnnotatedImage={onAttachAnnotatedImage}
          index={index}
          count={count}
          thumbnails={thumbnails}
          onSelect={onSelect}
          onClose={onClose}
        />
      </Suspense>
    </PreviewLoadBoundary>
  );
}
