import { z } from 'zod';

export const IPC_CHANNELS = {
  discoverConnection: 'kiki:connection:discover',
  cancelStartup: 'kiki:connection:cancelStartup',
  sshListProfiles: 'kiki:ssh:listProfiles',
  sshSaveProfile: 'kiki:ssh:saveProfile',
  sshRemoveProfile: 'kiki:ssh:removeProfile',
  sshConnectProfile: 'kiki:ssh:connectProfile',
  sshPrepareProfile: 'kiki:ssh:prepareProfile',
  sshResumeScopeConnection: 'kiki:ssh:resumeScopeConnection',
  sshCommitScopeConnection: 'kiki:ssh:commitScopeConnection',
  sshTakeScopeConnection: 'kiki:ssh:takeScopeConnection',
  sshTunnelRunning: 'kiki:ssh:tunnelRunning',
  sshDisconnectProfile: 'kiki:ssh:disconnectProfile',
  sshSetWorkspaceScope: 'kiki:ssh:setWorkspaceScope',
  windowShowMain: 'kiki:window:showMain',
  windowIsVisibleAndFocused: 'kiki:window:isVisibleAndFocused',
  windowSetTheme: 'kiki:window:setTheme',
  windowSetZoom: 'kiki:window:setZoom',
  windowGetMode: 'kiki:window:getMode',
  pluginFocusRead: 'kiki:pluginFocus:read',
  pluginFocusAck: 'kiki:pluginFocus:ack',
  pluginFocusRemember: 'kiki:pluginFocus:remember',
  notificationsSend: 'kiki:notifications:send',
  notificationsAcknowledge: 'kiki:notifications:acknowledge',
  notificationsTakeIntent: 'kiki:notifications:takeNavigationIntent',
  notificationsAckIntent: 'kiki:notifications:ackNavigationIntent',
  notificationsSetUnreadBadge: 'kiki:notifications:setUnreadBadge',
  filesOpenSaveSink: 'kiki:files:openSaveSink',
  filesWriteSaveSink: 'kiki:files:writeSaveSink',
  filesCloseSaveSink: 'kiki:files:closeSaveSink',
  filesAbortSaveSink: 'kiki:files:abortSaveSink',
  filesSaveBlob: 'kiki:files:saveBlob',
  filesPickFilePath: 'kiki:files:pickFilePath',
  filesPickFiles: 'kiki:files:pickFiles',
  filesReadSelectedFile: 'kiki:files:readSelectedFile',
  filesPickDirectory: 'kiki:files:pickDirectory',
  filesPickDirectories: 'kiki:files:pickDirectories',
  filesReadClipboardFiles: 'kiki:files:readClipboardFiles',
  filesReadDroppedFiles: 'kiki:files:readDroppedFiles',
  filesRevealPath: 'kiki:files:revealPath',
  filesOpenPath: 'kiki:files:openPath',
  filesOpenExternalUrl: 'kiki:files:openExternalUrl',
  filesWriteFileText: 'kiki:files:writeFileText',
  desktopReadPrefs: 'kiki:desktop:readPrefs',
  desktopWritePrefs: 'kiki:desktop:writePrefs',
  desktopGetAutostart: 'kiki:desktop:getAutostart',
  desktopSetAutostart: 'kiki:desktop:setAutostart',
  desktopActiveSpace: 'kiki:desktop:activeSpace',
  desktopSpaceStatuses: 'kiki:desktop:spaceStatuses',
  desktopSwitchSpace: 'kiki:desktop:switchSpace',
  desktopPrepareSpace: 'kiki:desktop:prepareSpace',
  desktopOpenSpace: 'kiki:desktop:openSpace',
  desktopOpenRemoteSpace: 'kiki:desktop:openRemoteSpace',
  desktopCreateSpaceShortcut: 'kiki:desktop:createSpaceShortcut',
  desktopRestartSpace: 'kiki:desktop:restartSpace',
  desktopRestartServer: 'kiki:desktop:restartServer',
  desktopLogInfo: 'kiki:desktop:logInfo',
  desktopOpenLogDirectory: 'kiki:desktop:openLogDirectory',
  desktopSupportsUpdates: 'kiki:desktop:supportsUpdates',
  desktopCheckUpdate: 'kiki:desktop:checkUpdate',
  desktopInstallUpdate: 'kiki:desktop:installUpdate',
  desktopMutateUpdateState: 'kiki:desktop:mutateUpdateState',
  desktopPeekSubscribeIntent: 'kiki:desktop:peekSubscribeIntent',
  desktopAckSubscribeIntent: 'kiki:desktop:ackSubscribeIntent',
} as const;

export const IPC_EVENTS = {
  backendStage: 'kiki:event:backendStage',
  notificationClick: 'kiki:event:notificationClick',
  trayNewSession: 'kiki:event:trayNewSession',
  subscribeIntent: 'kiki:event:subscribeIntent',
  subscribeUrl: 'kiki:event:subscribeUrl',
} as const;

const nonEmptyString = z.string().min(1);
const updateChannelSchema = z.enum(['stable', 'beta']);
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const windowModeSchema = z.enum(['switch', 'windows']);

export const navScopeIdentitySchema = z.object({
  homeId: nonEmptyString,
  scopeId: nonEmptyString,
  serverHomeId: z.string().optional(),
  connectionRef: z.string().optional(),
});

export const sshProfileSchema = z.object({
  id: nonEmptyString,
  label: z.string().min(1).max(256),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('alias'), alias: nonEmptyString }),
    z.object({
      kind: z.literal('host'),
      hostname: nonEmptyString,
      username: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
    }),
  ]),
  identityFile: z.string().nullable().optional(),
  releaseChannel: updateChannelSchema,
  remotePort: z.number().int().min(1).max(65535).nullable().optional(),
  serverHomeId: z.string().nullable().optional(),
});

export const hostNotificationSchema = z.object({
  title: nonEmptyString,
  body: z.string().optional(),
  route: z.string().optional(),
  homeId: z.string().optional(),
  scopeId: z.string().optional(),
  scope: navScopeIdentitySchema.optional(),
  sessionIds: z.array(z.string()).optional(),
  deliveryId: z.string().optional(),
  tag: z.string().optional(),
});

const updateStatePatchSchema = z.object({
  skipped: z
    .object({
      stable: z.array(z.string()).nullable().optional(),
      beta: z.array(z.string()).nullable().optional(),
    })
    .nullable()
    .optional(),
  snoozedUntil: z.number().finite().nonnegative().nullable().optional(),
  lastCheckedAt: z.number().finite().nonnegative().nullable().optional(),
});

export const desktopPrefsPatchSchema = z
  .object({
    notifications: z.boolean().optional(),
    closeToTray: z.boolean().optional(),
    locale: z.string().max(32).optional(),
    updateChannel: updateChannelSchema.optional(),
    autoUpdate: z.enum(['off', 'notify', 'install']).optional(),
    updateState: updateStatePatchSchema.nullable().optional(),
    logLevel: logLevelSchema.optional(),
    compatibility: z
      .object({
        homeKind: z.enum(['kimi', 'custom']),
        customHome: z.string().optional(),
      })
      .optional(),
    windowMode: windowModeSchema.optional(),
    window_mode: windowModeSchema.optional(),
  })
  .strict();

export const desktopUpdateMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checked'), at: z.number().finite().nonnegative() }),
  z.object({ kind: z.literal('snooze'), until: z.number().finite().nonnegative() }),
  z.object({ kind: z.literal('skip'), channel: updateChannelSchema, version: nonEmptyString }),
]);

const uint8ArraySchema = z.custom<Uint8Array>(
  (val) => val instanceof Uint8Array,
  { message: 'Expected a Uint8Array payload' },
);

export const IPC_SCHEMAS = {
  [IPC_CHANNELS.discoverConnection]: z.void(),
  [IPC_CHANNELS.cancelStartup]: z.void(),
  [IPC_CHANNELS.sshListProfiles]: z.void(),
  [IPC_CHANNELS.sshSaveProfile]: z.object({ profile: sshProfileSchema }),
  [IPC_CHANNELS.sshRemoveProfile]: z.object({ id: nonEmptyString }),
  [IPC_CHANNELS.sshConnectProfile]: z.object({ id: nonEmptyString, token: z.string() }),
  [IPC_CHANNELS.sshPrepareProfile]: z.object({ id: nonEmptyString, token: z.string() }),
  [IPC_CHANNELS.sshResumeScopeConnection]: z.object({
    homeId: nonEmptyString,
    id: nonEmptyString,
    tunnelId: nonEmptyString,
  }),
  [IPC_CHANNELS.sshCommitScopeConnection]: z.object({
    homeId: nonEmptyString,
    id: nonEmptyString,
    tunnelId: nonEmptyString,
    reload: z.boolean(),
  }),
  [IPC_CHANNELS.sshTakeScopeConnection]: z.void(),
  [IPC_CHANNELS.sshTunnelRunning]: z.object({ id: nonEmptyString, tunnelId: nonEmptyString }),
  [IPC_CHANNELS.sshDisconnectProfile]: z.object({ id: nonEmptyString, tunnelId: nonEmptyString }),
  [IPC_CHANNELS.sshSetWorkspaceScope]: z.object({ scope: z.enum(['local', 'ssh']) }),
  [IPC_CHANNELS.windowShowMain]: z.void(),
  [IPC_CHANNELS.windowIsVisibleAndFocused]: z.void(),
  [IPC_CHANNELS.windowSetTheme]: z.object({ theme: z.enum(['light', 'dark']) }),
  [IPC_CHANNELS.windowSetZoom]: z.object({ factor: z.number().finite().min(0.25).max(5) }),
  [IPC_CHANNELS.windowGetMode]: z.void(),
  [IPC_CHANNELS.pluginFocusRead]: z.void(),
  [IPC_CHANNELS.pluginFocusAck]: z.object({
    homeId: nonEmptyString,
    requestId: z.number().int().nonnegative(),
  }),
  [IPC_CHANNELS.pluginFocusRemember]: z.object({
    homeId: nonEmptyString,
    requestId: z.number().int().nonnegative(),
  }),
  [IPC_CHANNELS.notificationsSend]: hostNotificationSchema,
  [IPC_CHANNELS.notificationsAcknowledge]: z.object({
    sessionId: nonEmptyString,
    scope: navScopeIdentitySchema,
    deliveryId: z.string().optional(),
  }),
  [IPC_CHANNELS.notificationsTakeIntent]: z.void(),
  [IPC_CHANNELS.notificationsAckIntent]: z.object({ navigationId: nonEmptyString }),
  [IPC_CHANNELS.notificationsSetUnreadBadge]: z.object({
    count: z.number().int().min(0).max(0xffffffff),
    homeId: z.string().optional(),
    scopeId: z.string().optional(),
    sessionIds: z.array(z.string()).optional(),
  }),
  [IPC_CHANNELS.filesOpenSaveSink]: z.object({ filename: nonEmptyString.max(512) }),
  [IPC_CHANNELS.filesWriteSaveSink]: z.object({
    sinkId: nonEmptyString,
    chunk: uint8ArraySchema.refine((buf) => buf.byteLength <= 64 * 1024, {
      message: 'The save chunk exceeds 64 KiB',
    }),
  }),
  [IPC_CHANNELS.filesCloseSaveSink]: z.object({ sinkId: nonEmptyString }),
  [IPC_CHANNELS.filesAbortSaveSink]: z.object({ sinkId: nonEmptyString }),
  [IPC_CHANNELS.filesSaveBlob]: z.object({
    bytes: uint8ArraySchema,
    filename: nonEmptyString.max(512),
  }),
  [IPC_CHANNELS.filesPickFilePath]: z.void(),
  [IPC_CHANNELS.filesPickFiles]: z.void(),
  [IPC_CHANNELS.filesReadSelectedFile]: z.object({ token: nonEmptyString }),
  [IPC_CHANNELS.filesPickDirectory]: z.void(),
  [IPC_CHANNELS.filesPickDirectories]: z.void(),
  [IPC_CHANNELS.filesReadClipboardFiles]: z.void(),
  [IPC_CHANNELS.filesReadDroppedFiles]: z.object({ paths: z.array(nonEmptyString).max(512) }),
  [IPC_CHANNELS.filesRevealPath]: z.object({ path: nonEmptyString }),
  [IPC_CHANNELS.filesOpenPath]: z.object({ path: nonEmptyString }),
  [IPC_CHANNELS.filesOpenExternalUrl]: z.object({ url: nonEmptyString }),
  [IPC_CHANNELS.filesWriteFileText]: z.object({ path: nonEmptyString, text: z.string() }),
  [IPC_CHANNELS.desktopReadPrefs]: z.void(),
  [IPC_CHANNELS.desktopWritePrefs]: z.object({ prefs: desktopPrefsPatchSchema }),
  [IPC_CHANNELS.desktopGetAutostart]: z.void(),
  [IPC_CHANNELS.desktopSetAutostart]: z.object({ enabled: z.boolean() }),
  [IPC_CHANNELS.desktopActiveSpace]: z.void(),
  [IPC_CHANNELS.desktopSpaceStatuses]: z.void(),
  [IPC_CHANNELS.desktopSwitchSpace]: z.object({ homeId: nonEmptyString }),
  [IPC_CHANNELS.desktopPrepareSpace]: z.object({ homeId: nonEmptyString }),
  [IPC_CHANNELS.desktopOpenSpace]: z.object({ homeId: nonEmptyString }),
  [IPC_CHANNELS.desktopOpenRemoteSpace]: z.object({ connectionId: nonEmptyString }),
  [IPC_CHANNELS.desktopCreateSpaceShortcut]: z.object({ homeId: nonEmptyString }),
  [IPC_CHANNELS.desktopRestartSpace]: z.object({ homeId: nonEmptyString }),
  [IPC_CHANNELS.desktopRestartServer]: z.void(),
  [IPC_CHANNELS.desktopLogInfo]: z.void(),
  [IPC_CHANNELS.desktopOpenLogDirectory]: z.void(),
  [IPC_CHANNELS.desktopSupportsUpdates]: z.void(),
  [IPC_CHANNELS.desktopCheckUpdate]: z.object({ channel: updateChannelSchema.optional() }).optional(),
  [IPC_CHANNELS.desktopInstallUpdate]: z
    .object({
      expectedChannel: updateChannelSchema.optional(),
      expectedVersion: nonEmptyString.optional(),
    })
    .optional(),
  [IPC_CHANNELS.desktopMutateUpdateState]: z.object({ mutation: desktopUpdateMutationSchema }),
  [IPC_CHANNELS.desktopPeekSubscribeIntent]: z.void(),
  [IPC_CHANNELS.desktopAckSubscribeIntent]: z.object({ id: nonEmptyString }),
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export function validateIpcPayload<T extends z.ZodType>(schema: T, payload: unknown): z.infer<T> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid IPC payload: ${details}`);
  }
  return result.data;
}
