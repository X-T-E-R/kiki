import { z } from 'zod';

const desktopSafeText = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001F\u007F]+$/);

const optionalNullable = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined) as unknown as z.ZodOptional<T>;

export const desktopSshTargetSchema = /* @__PURE__ */ z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('alias'), alias: desktopSafeText(255).regex(/^[^-\s][^\s]*$/) }).strict(),
  z.object({
    kind: z.literal('host'),
    hostname: desktopSafeText(255).regex(/^[a-zA-Z0-9.:_][a-zA-Z0-9.\-:_]*$/),
    username: optionalNullable(desktopSafeText(64).regex(/^[a-zA-Z0-9_.][a-zA-Z0-9._-]*$/)),
    port: optionalNullable(z.number().int().min(1).max(65535)),
  }).strict(),
]);
export type DesktopSshTarget = z.infer<typeof desktopSshTargetSchema>;

export const desktopReleaseChannelSchema = /* @__PURE__ */ z.enum(['stable', 'beta']);
export type DesktopReleaseChannel = z.infer<typeof desktopReleaseChannelSchema>;

export const desktopSshProfileSchema = /* @__PURE__ */ z.object({
  id: desktopSafeText(80).regex(/^[a-zA-Z0-9_-]+$/),
  label: desktopSafeText(100),
  target: desktopSshTargetSchema,
  identityFile: optionalNullable(desktopSafeText(4096)),
  releaseChannel: desktopReleaseChannelSchema,
  remotePort: optionalNullable(z.number().int().min(1).max(65535)),
  serverHomeId: optionalNullable(z.string().uuid()),
}).strict();
export type DesktopSshProfile = z.infer<typeof desktopSshProfileSchema>;

export const desktopSshProfilesResponseSchema = /* @__PURE__ */ z.object({
  profiles: z.array(desktopSshProfileSchema).max(100),
});
export type DesktopSshProfilesResponse = z.infer<typeof desktopSshProfilesResponseSchema>;

export const desktopSshProfilePutSchema = /* @__PURE__ */ z.object({
  profile: desktopSshProfileSchema,
}).strict();
export type DesktopSshProfilePut = z.infer<typeof desktopSshProfilePutSchema>;

export const desktopSshProfileParamsSchema = /* @__PURE__ */ z.object({
  id: desktopSafeText(80).regex(/^[a-zA-Z0-9_-]+$/),
});

export const desktopSshBearerTokenSchema = /* @__PURE__ */ z.string().length(43).regex(/^[a-zA-Z0-9_-]+$/);

export const desktopSshConnectSchema = /* @__PURE__ */ z.object({
  id: desktopSafeText(80).regex(/^[a-zA-Z0-9_-]+$/),
  token: desktopSshBearerTokenSchema,
  home_id: z.string().min(1).max(128).optional(),
  staged: z.boolean().default(false),
}).strict();
export type DesktopSshConnectInput = z.infer<typeof desktopSshConnectSchema>;

export const desktopSshConnectionConfigSchema = /* @__PURE__ */ z.object({
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/),
  token: desktopSshBearerTokenSchema,
}).strict();
export type DesktopSshConnectionConfig = z.infer<typeof desktopSshConnectionConfigSchema>;

export const desktopSshResolvedConnectionSchema = /* @__PURE__ */ z.object({
  config: desktopSshConnectionConfigSchema,
  tunnelId: z.string().min(1).max(64),
  serverHomeId: z.string().min(1).max(128),
  serverInstanceId: z.string().min(1).max(128),
  serverVersion: z.string().min(1).max(64),
  buildId: optionalNullable(z.string().min(1).max(128)),
  buildChannel: optionalNullable(z.string().min(1).max(32)),
}).strict();
export type DesktopSshResolvedConnection = z.infer<typeof desktopSshResolvedConnectionSchema>;

export const desktopSshConnectResponseSchema = /* @__PURE__ */ z.object({
  connection: desktopSshResolvedConnectionSchema,
});
export type DesktopSshConnectResponse = z.infer<typeof desktopSshConnectResponseSchema>;

export const desktopSshResumeSchema = /* @__PURE__ */ z.object({
  home_id: z.string().min(1).max(128),
  id: desktopSafeText(80).regex(/^[a-zA-Z0-9_-]+$/),
  tunnel_id: z.string().min(1).max(64),
}).strict();
export type DesktopSshResumeInput = z.infer<typeof desktopSshResumeSchema>;

export const desktopSshResumeResponseSchema = /* @__PURE__ */ z.object({
  profile: desktopSshProfileSchema,
  connection: desktopSshResolvedConnectionSchema,
});
export type DesktopSshResumeResponse = z.infer<typeof desktopSshResumeResponseSchema>;

export const desktopSshCommitSchema = /* @__PURE__ */ z.object({
  home_id: z.string().min(1).max(128),
  id: desktopSafeText(80).regex(/^[a-zA-Z0-9_-]+$/),
  tunnel_id: z.string().min(1).max(64),
  reload: z.boolean(),
}).strict();
export type DesktopSshCommitInput = z.infer<typeof desktopSshCommitSchema>;

export const desktopSshCommitResponseSchema = /* @__PURE__ */ z.object({
  committed: z.literal(true),
});

export const desktopSshTunnelParamsSchema = /* @__PURE__ */ z.object({
  id: desktopSafeText(80).regex(/^[a-zA-Z0-9_-]+$/),
  tunnelId: z.string().min(1).max(64),
});

export const desktopSshTunnelRunningResponseSchema = /* @__PURE__ */ z.object({
  running: z.boolean(),
});

export const desktopSshDisconnectResponseSchema = /* @__PURE__ */ z.object({
  disconnected: z.literal(true),
});

export const KIKI_APP_SCHEME = 'kiki-app';
export const KIKI_APP_ORIGIN = 'kiki-app://localhost';

export const KIKI_APP_CSP =
  "default-src 'self' kiki-app:; " +
  "connect-src 'self' kiki-app: https: http: ws: wss: data: blob:; " +
  "img-src 'self' kiki-app: data: blob: https: http:; " +
  "media-src 'self' kiki-app: blob: data: https: http:; " +
  "font-src 'self' kiki-app: data:; " +
  "style-src 'self' kiki-app: 'unsafe-inline'; " +
  "script-src 'self' kiki-app:; " +
  "frame-src 'self' kiki-app: http://*.kiki-document.localhost:* https: http: blob:; " +
  "worker-src 'self' kiki-app: blob:";
