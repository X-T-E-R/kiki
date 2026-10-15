/**
 * outputLayerStore — manages user view preferences (active preset & view mode per session)
 * and holds the latest server OutputLayerConfiguration.
 *
 * It does NOT fabricate presets or duplicate derived results; derivation caching
 * is solely owned by the backend OutputLayerClient.
 */

import { useSyncExternalStore } from 'react';
import {
  OUTPUT_LAYER_DEFAULT_PRESETS,
  OUTPUT_LAYER_DEFAULT_SETTINGS,
  hasConfiguredModel,
  type OutputLayerConfiguration,
  type OutputLayerPreset,
  type OutputLayerSettings,
  type OutputLayerSessionState,
  type OutputLayerViewMode,
} from './types';
import type { OutputLayerClient } from '../../lib/outputLayerClient';
import { useOptionalConnection } from '../../state/connection';

const STORAGE_SESSION_STATE_KEY = 'kiki.output-layer.sessions.v1';

export interface SavePresetOptions {
  settings?: OutputLayerSettings;
  client?: OutputLayerClient | null;
  sessionId?: string;
  contextKey?: string;
}

export interface OutputLayerStoreSnapshot {
  configuration: OutputLayerConfiguration | null;
  configurations: Record<string, OutputLayerConfiguration | null>;
  sessions: Record<string, OutputLayerSessionState>;
}

class OutputLayerStore {
  private activeClient: OutputLayerClient | null = null;
  private configuration: OutputLayerConfiguration | null = null;
  private configurations: Record<string, OutputLayerConfiguration | null> = {};
  private sessions: Record<string, OutputLayerSessionState> = this.loadSessionStates();
  private listeners = new Set<() => void>();
  private snapshot: OutputLayerStoreSnapshot = {
    configuration: null,
    configurations: {},
    sessions: this.sessions,
  };

  private loadSessionStates(): Record<string, OutputLayerSessionState> {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_SESSION_STATE_KEY);
        if (saved) {
          return JSON.parse(saved) as Record<string, OutputLayerSessionState>;
        }
      }
    } catch {
      // Fallback to empty
    }
    return {};
  }

  private saveSessionStates() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_SESSION_STATE_KEY, JSON.stringify(this.sessions));
      }
    } catch {
      // Ignore
    }
  }

  private notify() {
    this.snapshot = {
      configuration: this.configuration,
      configurations: { ...this.configurations },
      sessions: this.sessions,
    };
    this.listeners.forEach((listener) => listener());
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public getSnapshot = (): OutputLayerStoreSnapshot => {
    return this.snapshot;
  };

  public getActiveClient(): OutputLayerClient | null {
    return this.activeClient;
  }

  public setActiveClient(client: OutputLayerClient | null): void {
    this.activeClient = client;
  }

  // Configuration management via backend client
  public setConfiguration(config: OutputLayerConfiguration | null, contextKey?: string) {
    if (contextKey) {
      this.configurations[contextKey] = config;
    } else {
      this.configuration = config;
    }
    this.notify();
  }

  public getConfiguration(contextKey?: string): OutputLayerConfiguration | null {
    if (contextKey) {
      return this.configurations[contextKey] ?? null;
    }
    return this.configuration;
  }

  public async fetchConfiguration(
    client: OutputLayerClient,
    options?: { sessionId?: string; contextKey?: string },
  ): Promise<OutputLayerConfiguration> {
    try {
      const config = await client.configuration(options?.sessionId ? { sessionId: options.sessionId } : undefined);
      if (options?.contextKey) {
        this.configurations[options.contextKey] = config;
      }
      if (!options?.contextKey || !options?.sessionId) {
        this.configuration = config;
      }
      this.notify();
      return config;
    } catch (err) {
      const fallback: OutputLayerConfiguration = {
        enabled: false,
        presets: [],
        settings: { groupChars: 600, preloadBefore: 1, preloadAfter: 1, historyTokens: 16384 },
      };
      if (options?.contextKey) {
        this.configurations[options.contextKey] = fallback;
      }
      if (!options?.contextKey || !options?.sessionId) {
        this.configuration = fallback;
      }
      this.notify();
      throw err;
    }
  }

  public async saveConfiguration(
    client: OutputLayerClient,
    input: Pick<OutputLayerConfiguration, 'presets' | 'settings'>,
    options?: { sessionId?: string; contextKey?: string },
  ): Promise<OutputLayerConfiguration> {
    const updated = await client.configure(input);
    const effective = options?.sessionId
      ? await client.configuration({ sessionId: options.sessionId })
      : updated;
    if (options?.contextKey) {
      this.configurations[options.contextKey] = effective;
    }
    if (!options?.contextKey || !options?.sessionId) {
      this.configuration = effective;
    }
    this.notify();
    return effective;
  }

  // Session Preferences
  public getSessionState(sessionId?: string): OutputLayerSessionState {
    const id = sessionId ?? '__global__';
    return (
      this.sessions[id] ?? {
        activePresetId: null,
        viewMode: 'processed',
      }
    );
  }

  public setActivePreset(sessionId: string | undefined, presetId: string | null) {
    const id = sessionId ?? '__global__';
    const current = this.getSessionState(id);
    this.sessions = {
      ...this.sessions,
      [id]: {
        ...current,
        activePresetId: presetId,
        viewMode: presetId !== null ? 'processed' : current.viewMode,
      },
    };
    this.saveSessionStates();
    this.notify();
  }

  public setViewMode(sessionId: string | undefined, viewMode: OutputLayerViewMode) {
    const id = sessionId ?? '__global__';
    const current = this.getSessionState(id);
    this.sessions = {
      ...this.sessions,
      [id]: {
        ...current,
        viewMode,
      },
    };
    this.saveSessionStates();
    this.notify();
  }

  public getPresets(contextKey?: string): readonly OutputLayerPreset[] {
    if (contextKey && this.configurations[contextKey] !== undefined) {
      return this.configurations[contextKey]?.presets ?? [];
    }
    return this.configuration?.presets ?? OUTPUT_LAYER_DEFAULT_PRESETS;
  }

  public getPreset(presetId: string, contextKey?: string): OutputLayerPreset | undefined {
    return this.getPresets(contextKey).find((p) => p.id === presetId);
  }

  public async savePreset(
    preset: OutputLayerPreset,
    optionsOrSettings?: SavePresetOptions | OutputLayerSettings | OutputLayerClient | null,
    clientArg?: OutputLayerClient | null,
  ): Promise<OutputLayerConfiguration> {
    let activeClient: OutputLayerClient | null = null;
    let explicitSettings: OutputLayerSettings | undefined;
    let sessionId: string | undefined;
    let contextKey: string | undefined;

    if (optionsOrSettings && typeof (optionsOrSettings as OutputLayerClient).configuration === 'function') {
      activeClient = optionsOrSettings as OutputLayerClient;
    } else if (
      optionsOrSettings &&
      typeof optionsOrSettings === 'object' &&
      ('settings' in optionsOrSettings || 'client' in optionsOrSettings || 'sessionId' in optionsOrSettings || 'contextKey' in optionsOrSettings)
    ) {
      const opts = optionsOrSettings as SavePresetOptions;
      explicitSettings = opts.settings;
      sessionId = opts.sessionId;
      contextKey = opts.contextKey;
      if (opts.client !== undefined) {
        activeClient = opts.client;
      } else if (clientArg !== undefined) {
        activeClient = clientArg;
      } else {
        activeClient = this.activeClient;
      }
    } else {
      if (optionsOrSettings) {
        explicitSettings = optionsOrSettings as OutputLayerSettings;
      }
      if (clientArg !== undefined) {
        activeClient = clientArg;
      } else {
        activeClient = this.activeClient;
      }
    }

    if (!activeClient) {
      throw new Error('Output layer client not connected');
    }

    const currentPresets = [...this.getPresets(contextKey)];
    const index = currentPresets.findIndex((p) => p.id === preset.id);
    const nextPresets = index >= 0
      ? currentPresets.map((p, i) => (i === index ? preset : p))
      : [...currentPresets, preset];
    const currentConfig = contextKey ? this.configurations[contextKey] : this.configuration;
    const settings = explicitSettings ?? currentConfig?.settings ?? this.configuration?.settings ?? OUTPUT_LAYER_DEFAULT_SETTINGS;

    return this.saveConfiguration(
      activeClient,
      { presets: nextPresets, settings },
      { sessionId, contextKey },
    );
  }

  public async deletePreset(
    presetId: string,
    optionsOrClient?: { client?: OutputLayerClient | null; sessionId?: string; contextKey?: string } | OutputLayerClient | null,
    clientArg?: OutputLayerClient | null,
  ): Promise<OutputLayerConfiguration> {
    let activeClient: OutputLayerClient | null = null;
    let sessionId: string | undefined;
    let contextKey: string | undefined;

    if (optionsOrClient && typeof (optionsOrClient as OutputLayerClient).configuration === 'function') {
      activeClient = optionsOrClient as OutputLayerClient;
    } else if (
      optionsOrClient &&
      typeof optionsOrClient === 'object' &&
      ('client' in optionsOrClient || 'sessionId' in optionsOrClient || 'contextKey' in optionsOrClient)
    ) {
      const opts = optionsOrClient as { client?: OutputLayerClient | null; sessionId?: string; contextKey?: string };
      sessionId = opts.sessionId;
      contextKey = opts.contextKey;
      if (opts.client !== undefined) {
        activeClient = opts.client;
      } else if (clientArg !== undefined) {
        activeClient = clientArg;
      } else {
        activeClient = this.activeClient;
      }
    } else {
      if (clientArg !== undefined) {
        activeClient = clientArg;
      } else if (optionsOrClient !== undefined) {
        activeClient = optionsOrClient as OutputLayerClient | null;
      } else {
        activeClient = this.activeClient;
      }
    }

    if (!activeClient) {
      throw new Error('Output layer client not connected');
    }

    const currentPresets = [...this.getPresets(contextKey)];
    const nextPresets = currentPresets.filter((p) => p.id !== presetId);
    const currentConfig = contextKey ? this.configurations[contextKey] : this.configuration;
    const settings = currentConfig?.settings ?? this.configuration?.settings ?? OUTPUT_LAYER_DEFAULT_SETTINGS;

    return this.saveConfiguration(
      activeClient,
      { presets: nextPresets, settings },
      { sessionId, contextKey },
    );
  }

  public getActivePreset(sessionId?: string, contextKey?: string): OutputLayerPreset | undefined {
    const state = this.getSessionState(sessionId);
    if (!state.activePresetId) return undefined;
    return this.getPreset(state.activePresetId, contextKey);
  }
}

export const outputLayerStore = new OutputLayerStore();

/**
 * Hook to consume Output Layer state and configuration for a given session.
 */
export function useOutputLayer(sessionId?: string) {
  const connection = useOptionalConnection();
  const scopeKey = connection?.spaceKey ?? connection?.scopeId ?? 'local';
  const serverId = connection?.meta?.server_id ?? '';
  const contextKey = `${scopeKey}:${serverId}:${sessionId ?? '__all__'}`;

  const snapshot = useSyncExternalStore(outputLayerStore.subscribe, outputLayerStore.getSnapshot, outputLayerStore.getSnapshot);
  const sessionKey = connection ? contextKey : sessionId;
  const sessionState = outputLayerStore.getSessionState(sessionKey);

  const configuration = connection
    ? snapshot.configurations[contextKey] ?? null
    : snapshot.configurations[contextKey] ?? snapshot.configuration;
  const isPluginEnabled = configuration?.enabled ?? false;
  const presets = configuration?.presets ?? OUTPUT_LAYER_DEFAULT_PRESETS;
  const settings = configuration?.settings ?? OUTPUT_LAYER_DEFAULT_SETTINGS;

  const activePreset = sessionState.activePresetId
    ? presets.find((p) => p.id === sessionState.activePresetId)
    : undefined;

  const isModelConfigured = hasConfiguredModel(activePreset);
  const isOutputLayerActive = Boolean(isPluginEnabled && activePreset !== undefined);
  const isProcessingEnabled = Boolean(isOutputLayerActive && isModelConfigured);

  return {
    contextKey,
    configuration,
    isPluginEnabled,
    presets,
    settings,
    activePresetId: sessionState.activePresetId,
    activePreset,
    isModelConfigured,
    isOutputLayerActive,
    viewMode: sessionState.viewMode,
    isProcessingEnabled,
    setActivePreset: (presetId: string | null) =>
      outputLayerStore.setActivePreset(sessionKey, presetId),
    setViewMode: (viewMode: OutputLayerViewMode) =>
      outputLayerStore.setViewMode(sessionKey, viewMode),
    savePreset: (
      preset: OutputLayerPreset,
      settingsOrOptions?: OutputLayerSettings | SavePresetOptions | OutputLayerClient | null,
      client?: OutputLayerClient | null,
    ) => {
      if (settingsOrOptions && typeof (settingsOrOptions as OutputLayerClient).configuration === 'function') {
        return outputLayerStore.savePreset(preset, {
          client: settingsOrOptions as OutputLayerClient,
          sessionId,
          contextKey,
        });
      }
      if (
        settingsOrOptions &&
        typeof settingsOrOptions === 'object' &&
        ('settings' in settingsOrOptions || 'client' in settingsOrOptions || 'sessionId' in settingsOrOptions || 'contextKey' in settingsOrOptions)
      ) {
        return outputLayerStore.savePreset(preset, {
          sessionId,
          contextKey,
          ...(settingsOrOptions as SavePresetOptions),
        });
      }
      return outputLayerStore.savePreset(preset, {
        settings: settingsOrOptions as OutputLayerSettings | undefined,
        client,
        sessionId,
        contextKey,
      });
    },
    saveConfiguration: (
      client: OutputLayerClient,
      input: Pick<OutputLayerConfiguration, 'presets' | 'settings'>,
      options?: { sessionId?: string; contextKey?: string },
    ) => outputLayerStore.saveConfiguration(client, input, { sessionId, contextKey, ...options }),
    deletePreset: (
      presetId: string,
      optionsOrClient?: { client?: OutputLayerClient | null; sessionId?: string; contextKey?: string } | OutputLayerClient | null,
      client?: OutputLayerClient | null,
    ) => {
      if (optionsOrClient && typeof (optionsOrClient as OutputLayerClient).configuration === 'function') {
        return outputLayerStore.deletePreset(presetId, {
          client: optionsOrClient as OutputLayerClient,
          sessionId,
          contextKey,
        });
      }
      if (
        optionsOrClient &&
        typeof optionsOrClient === 'object' &&
        ('client' in optionsOrClient || 'sessionId' in optionsOrClient || 'contextKey' in optionsOrClient)
      ) {
        return outputLayerStore.deletePreset(presetId, {
          sessionId,
          contextKey,
          ...optionsOrClient,
        });
      }
      return outputLayerStore.deletePreset(presetId, {
        client: (optionsOrClient as OutputLayerClient | null | undefined) ?? client,
        sessionId,
        contextKey,
      });
    },
  };
}
