import type { z } from 'zod';
import type {
  portableSpaceAddRecipientInputSchema,
  portableSpaceApplyInputSchema,
  portableSpaceCenterDirectSyncInputSchema,
  portableSpaceCenterSubscribeInputSchema,
  portableSpaceCenterTokenSyncInputSchema,
  portableSpaceDeltaInputSchema,
  portableSpaceExportInputSchema,
  portableSpaceForkInputSchema,
  portableSpaceInspectInputSchema,
  portableSpaceMutateInputSchema,
  portableSpacePackUnpackInputSchema,
  portableSpacePatchSourceInputSchema,
  portableSpacePreviewInputSchema,
  portableSpaceRegisterSourceInputSchema,
  portableSpaceRekeyInputSchema,
  portableSpaceRemoveReviewedInputSchema,
  portableSpaceReorderSourcesInputSchema,
  portableSpaceSourcePreviewInputSchema,
  portableSpaceSubscribeInputSchema,
  portableSpaceSubscribePreviewInputSchema,
  portableSpaceSubscriptionSyncInputSchema,
  PortableSpaceApplyReceipt,
  PortableSpaceCenterCommit,
  PortableSpaceCenterSourcesListResponse,
  PortableSpaceExportReceipt,
  PortableSpaceInspectResult,
  PortableSpaceMutateReceipt,
  PortableSpacePatchSourceResult,
  PortableSpacePreviewResult,
  PortableSpaceRemovePreviewResult,
  PortableSpaceRemoveReviewedResponse,
  PortableSpaceRemoveSourceResponse,
  PortableSpaceReorderSourcesResult,
  PortableSpaceSourceRecord,
  PortableSpaceSourcesListResponse,
  PortableSpaceSubscribePreviewManifest,
  PortableSpaceSubscriptionSyncResult,
} from '@kiki/protocol';
import type { HttpRestRequestOptions } from './http-rest.js';

export interface PortableSpaceViewRequestOptions extends HttpRestRequestOptions {
  readonly view?: 'center-v1';
}

export type PortableSpacePackInput = Omit<z.input<typeof portableSpacePackUnpackInputSchema>, 'action'> & {
  readonly action?: 'pack';
};

export type PortableSpaceUnpackInput = Omit<z.input<typeof portableSpacePackUnpackInputSchema>, 'action'> & {
  readonly action?: 'unpack';
};

/** Typed local-owner REST facade covering all 21 `/api/spaces/portable/*` operations. */
export interface PortableSpacesFacade {
  listSources(options: PortableSpaceViewRequestOptions & { readonly view: 'center-v1' }): Promise<PortableSpaceCenterSourcesListResponse>;
  listSources(options?: HttpRestRequestOptions): Promise<PortableSpaceSourcesListResponse>;
  listSources(options?: PortableSpaceViewRequestOptions): Promise<PortableSpaceSourcesListResponse | PortableSpaceCenterSourcesListResponse>;

  registerSource(
    input: z.input<typeof portableSpaceRegisterSourceInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceSourceRecord>;

  previewSubscribe(
    input: z.input<typeof portableSpaceSubscribePreviewInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceSubscribePreviewManifest>;

  subscribe(
    input: z.input<typeof portableSpaceCenterSubscribeInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceCenterCommit>;
  subscribe(
    input: z.input<typeof portableSpaceSubscribeInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceSubscriptionSyncResult>;

  previewSource(
    id: string,
    input?: z.input<typeof portableSpaceSourcePreviewInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceSubscribePreviewManifest>;

  syncSubscription(
    id: string,
    input: z.input<typeof portableSpaceCenterTokenSyncInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceCenterCommit>;
  syncSubscription(
    id: string,
    input: z.input<typeof portableSpaceCenterDirectSyncInputSchema> | undefined,
    options: PortableSpaceViewRequestOptions & { readonly view: 'center-v1' },
  ): Promise<PortableSpaceCenterCommit>;
  syncSubscription(
    id: string,
    input?: z.input<typeof portableSpaceSubscriptionSyncInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceSubscriptionSyncResult>;

  patchSource(
    id: string,
    input: z.input<typeof portableSpacePatchSourceInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpacePatchSourceResult>;

  reorderSources(
    input: z.input<typeof portableSpaceReorderSourcesInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceReorderSourcesResult>;

  previewRemoveSource(
    id: string,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceRemovePreviewResult>;

  removeSource(
    id: string,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceRemoveSourceResponse>;

  removeReviewedSource(
    id: string,
    input: z.input<typeof portableSpaceRemoveReviewedInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceRemoveReviewedResponse>;

  inspect(
    input: z.input<typeof portableSpaceInspectInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceInspectResult>;

  exportSpace(
    input: z.input<typeof portableSpaceExportInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceExportReceipt>;

  preview(
    input: z.input<typeof portableSpacePreviewInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpacePreviewResult>;

  apply(
    input: z.input<typeof portableSpaceApplyInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceApplyReceipt>;

  pack(
    input: PortableSpacePackInput,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceExportReceipt>;

  unpack(
    input: PortableSpaceUnpackInput,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceExportReceipt>;

  fork(
    input: z.input<typeof portableSpaceForkInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceExportReceipt>;

  delta(
    input: z.input<typeof portableSpaceDeltaInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceExportReceipt>;

  mutate(
    input: z.input<typeof portableSpaceMutateInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceMutateReceipt>;

  rekey(
    input: z.input<typeof portableSpaceRekeyInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceInspectResult>;

  addRecipient(
    input: z.input<typeof portableSpaceAddRecipientInputSchema>,
    options?: HttpRestRequestOptions,
  ): Promise<PortableSpaceSourcesListResponse>;
}
