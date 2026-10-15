/**
 * Types for Kiki Output Layer.
 * Re-exports the canonical contracts from @kiki/protocol and outputLayerClient.
 */

export type {
  OutputLayerConfiguration,
  OutputLayerPreset,
  OutputLayerSettings,
  OutputLayerStatus,
} from '@kiki/protocol';

export {
  OUTPUT_LAYER_DEFAULT_PRESETS,
  OUTPUT_LAYER_DEFAULT_SETTINGS,
} from '@kiki/protocol';

export type {
  OutputLayerSource,
  OutputLayerResult,
  OutputLayerStorage,
} from '../../lib/outputLayerClient';

export {
  OutputLayerClient,
  splitOutputLayerText,
  outputLayerViewportIndices,
} from '../../lib/outputLayerClient';

export type OutputLayerViewMode = 'processed' | 'original';

export interface OutputLayerSessionState {
  activePresetId: string | null;
  viewMode: OutputLayerViewMode;
}

export interface StreamProcessChunkOptions {
  sessionId: string;
  messageId: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  preset: import('@kiki/protocol').OutputLayerPreset;
  settings?: import('@kiki/protocol').OutputLayerSettings;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

/**
 * Check if a preset has a valid, explicit model configured.
 * Model IDs are opaque; only empty catalog IDs and incomplete custom bindings are unconfigured.
 */
export function hasConfiguredModel(preset?: import('@kiki/protocol').OutputLayerPreset | null): boolean {
  if (!preset) return false;
  const hasCatalogModel =
    typeof preset.modelId === 'string' &&
    preset.modelId.trim() !== '';
  const hasCustomModel =
    typeof preset.connectionId === 'string' &&
    preset.connectionId.trim() !== '' &&
    typeof preset.customModelId === 'string' &&
    preset.customModelId.trim() !== '';
  return Boolean(hasCatalogModel || hasCustomModel);
}
