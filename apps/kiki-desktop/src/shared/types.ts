import type {
  CompatibilitySettings,
  DesktopLogLevel,
  DesktopNativePrefs,
  DesktopUpdateState,
  SpaceWindowMode,
  UpdateChannel,
} from '@kiki/session-core/settings';

export type {
  CompatibilitySettings,
  DesktopLogLevel,
  DesktopNativePrefs,
  DesktopUpdateState,
  SpaceWindowMode,
  UpdateChannel,
};

export interface ConnectionConfig {
  readonly url: string;
  readonly token: string;
}

export interface LocalConnection {
  readonly config: ConnectionConfig;
  readonly persist: boolean;
}

export interface SshProfile {
  readonly id: string;
  readonly label: string;
  readonly target:
    | { readonly kind: 'alias'; readonly alias: string }
    | { readonly kind: 'host'; readonly hostname: string; readonly username?: string; readonly port?: number };
  readonly identityFile?: string | null;
  readonly releaseChannel: 'stable' | 'beta';
  readonly remotePort?: number | null;
  readonly serverHomeId?: string | null;
}

export interface SshResolvedConnection {
  readonly config: ConnectionConfig;
  readonly tunnelId: string;
  readonly serverHomeId: string;
  readonly serverInstanceId: string;
  readonly serverVersion: string;
  readonly buildId: string | null;
  readonly buildChannel: string | null;
}

export interface NavScopeIdentity {
  readonly homeId: string;
  readonly scopeId: string;
  readonly serverHomeId?: string;
  readonly connectionRef?: string;
}

export interface HostNotification {
  readonly title: string;
  readonly body?: string;
  readonly route?: string;
  readonly homeId?: string;
  readonly scopeId?: string;
  readonly scope?: NavScopeIdentity;
  readonly sessionIds?: readonly string[];
  readonly deliveryId?: string;
  readonly tag?: string;
}

export interface NotificationNavigationIntent {
  readonly route: string;
  readonly homeId?: string;
  readonly scope?: NavScopeIdentity;
  readonly navigationId?: string;
}

export interface HostSubscribeIntent {
  readonly id: string;
  readonly url: string;
  readonly name?: string;
  readonly mode?: 'auto' | 'manual' | 'once';
}

export interface HostFileDrop {
  readonly paths: readonly string[];
  readonly position?: { readonly x: number; readonly y: number };
}

export interface DesktopWindowMode {
  readonly presetId: string;
  readonly windowId: string;
}

export interface DesktopSpace {
  readonly homeId: string;
  readonly name: string;
  readonly color?: string | null;
  readonly preset?: string | null;
  readonly path: string;
  readonly baseHome?: string | null;
  readonly credentialsShared: boolean;
}

export interface LocalSpaceSummary {
  readonly homeId: string;
  readonly name: string;
  readonly path: string;
  readonly status: 'running' | 'background' | 'stopped';
  readonly active: boolean;
  readonly managed?: boolean;
}

export interface DesktopSpaceStatus {
  readonly homeId: string;
  readonly active: boolean;
  readonly hot: boolean;
  readonly pendingCount: number;
  readonly busyCount: number;
}

export interface DesktopAutostartStatus {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly command?: string | null;
}

export interface DesktopLogInfo {
  readonly directory: string;
  readonly backendLogPath: string;
  readonly maxBytes: number;
  readonly backups: number;
  readonly logLevel: DesktopLogLevel;
  readonly appliesOnNextLaunch: boolean;
}

export type DesktopUpdateMutation =
  | { readonly kind: 'checked'; readonly at: number }
  | { readonly kind: 'snooze'; readonly until: number }
  | { readonly kind: 'skip'; readonly channel: UpdateChannel; readonly version: string };

export interface DesktopUpdateOffer {
  readonly currentVersion: string;
  readonly version: string;
  readonly date?: string;
  readonly notes?: string;
}

export interface PluginFocusIntent {
  readonly homeId: string;
  readonly route: string;
  readonly requestId: number;
}

export interface SelectedFileDescriptor {
  readonly token: string;
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

export interface ReadFilesResult {
  readonly paths: readonly string[];
  readonly files: SelectedFileDescriptor[];
}

export interface BackendStagePayload {
  readonly stage: 'checking' | 'waiting' | 'starting' | 'ready' | 'failed';
  readonly message?: string;
  readonly homeId?: string;
}

export interface ElectronBridge {
  discoverConnection(): Promise<LocalConnection | null>;
  cancelStartup(): Promise<void>;
  onBackendStage(cb: (payload: unknown) => void): () => void;
  readonly ssh: {
    listProfiles(): Promise<SshProfile[]>;
    saveProfile(profile: SshProfile): Promise<SshProfile[]>;
    removeProfile(id: string): Promise<SshProfile[]>;
    connectProfile(id: string, token: string): Promise<SshResolvedConnection>;
    prepareProfile(id: string, token: string): Promise<SshResolvedConnection>;
    resumeScopeConnection(
      homeId: string,
      id: string,
      tunnelId: string,
    ): Promise<{ profile: SshProfile; connection: SshResolvedConnection }>;
    commitScopeConnection(homeId: string, id: string, tunnelId: string, reload: boolean): Promise<void>;
    takeScopeConnection(): Promise<{ profile: SshProfile; connection: SshResolvedConnection } | null>;
    tunnelRunning(id: string, tunnelId: string): Promise<boolean>;
    disconnectProfile(id: string, tunnelId: string): Promise<void>;
    setWorkspaceScope(scope: 'local' | 'ssh'): void;
  };
  readonly window: {
    showMainWindow(): Promise<void>;
    isVisibleAndFocused(): Promise<boolean>;
    setTheme(theme: 'light' | 'dark' | 'system'): Promise<void>;
    setZoom(factor: number): Promise<boolean>;
    getWindowMode(): Promise<DesktopWindowMode | null>;
    onFocus(cb: () => void): () => void;
  };
  readonly pluginFocus: {
    read(): Promise<PluginFocusIntent | null>;
    ack(homeId: string, requestId: number): Promise<void>;
    remember(homeId: string, requestId: number): Promise<void>;
  };
  readonly notifications: {
    send(options: HostNotification): Promise<void>;
    acknowledge(sessionId: string, scope: NavScopeIdentity, deliveryId?: string): Promise<void>;
    onClick(cb: (route: string, homeId?: string, scope?: NavScopeIdentity) => void): () => void;
    takeNavigationIntent(): Promise<NotificationNavigationIntent | { readonly connectionId: string } | null>;
    setUnreadBadge(count: number, homeId?: string, scopeId?: string, sessionIds?: readonly string[]): Promise<void>;
  };
  readonly files: {
    openSaveSink(filename: string): Promise<{ sinkId: string } | null>;
    writeSaveSink(sinkId: string, chunk: Uint8Array): Promise<void>;
    closeSaveSink(sinkId: string): Promise<boolean>;
    abortSaveSink(sinkId: string): Promise<void>;
    saveBlob(bytes: Uint8Array, filename: string): Promise<boolean>;
    pickFilePath(): Promise<string | null>;
    pickFiles(): Promise<SelectedFileDescriptor[] | null>;
    readSelectedFile(token: string): Promise<Uint8Array>;
    pickDirectory(): Promise<string | null>;
    pickDirectories(): Promise<readonly string[] | null>;
    readClipboardFiles(): Promise<ReadFilesResult | null>;
    readDroppedFiles(paths: readonly string[]): Promise<ReadFilesResult>;
    onFileDrop(cb: (drop: HostFileDrop) => void): () => void;
    revealPath(path: string): Promise<void>;
    openPath(path: string): Promise<void>;
    openExternalUrl(url: string): Promise<void>;
    writeFileText(path: string, text: string): Promise<void>;
  };
  readonly desktop: {
    readPrefs(): Promise<DesktopNativePrefs | null>;
    writePrefs(prefs: Partial<DesktopNativePrefs>): Promise<void>;
    getAutostart(): Promise<DesktopAutostartStatus | null>;
    setAutostart(enabled: boolean): Promise<DesktopAutostartStatus>;
    activeSpace(): Promise<unknown>;
    spaceStatuses(): Promise<readonly DesktopSpaceStatus[]>;
    switchSpace(homeId: string): Promise<void>;
    prepareSpace(homeId: string): Promise<{ readonly homeId: string }>;
    openSpace(homeId: string): Promise<void>;
    openRemoteSpace(connectionId: string): Promise<void>;
    createSpaceShortcut(homeId: string): Promise<{ readonly homeId: string; readonly path: string }>;
    restartSpace(homeId: string): Promise<void>;
    restartServer(): Promise<void>;
    logInfo(): Promise<DesktopLogInfo>;
    openLogDirectory(): Promise<void>;
    supportsUpdates(): Promise<boolean>;
    checkUpdate(channel?: UpdateChannel): Promise<DesktopUpdateOffer | null>;
    installUpdate(expectedChannel?: UpdateChannel, expectedVersion?: string): Promise<void>;
    mutateUpdateState(mutation: DesktopUpdateMutation): Promise<DesktopUpdateState>;
    onTrayNewSession(cb: () => void): () => void;
    peekSubscribeIntent(): Promise<HostSubscribeIntent | null>;
    ackSubscribeIntent(id: string): Promise<boolean>;
    onSubscribeIntent(cb: (intent: HostSubscribeIntent) => void): () => void;
    onSubscribeUrl(cb: (url: string) => void): () => void;
  };
}
