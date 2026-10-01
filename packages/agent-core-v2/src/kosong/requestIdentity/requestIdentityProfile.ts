import type {
  RequestIdentityHeader,
  RequestIdentityProfile,
  RequestIdentityProfileDraft,
  RequestIdentityTrackId,
  RequestIdentityTrackRevision,
} from '@kiki/protocol';
import { Error2 } from '#/_base/errors/errors';
import { RequestIdentityErrors } from './errors';
import { requestIdentityFromWire, type RequestIdentityProfileAxes } from './requestIdentityPolicy';

/** Placeholders a profile template may use; any other `{name}` is rejected on save. */
export const REQUEST_IDENTITY_TEMPLATE_VARIABLES = [
  'version',
  'kiki_version',
  'model',
  'os_type',
  'os_version',
  'arch',
  'platform',
  'node_arch',
  'stainless_os',
  'stainless_arch',
  'grok_os',
  'grok_arch',
] as const;

export type RequestIdentityTemplateVariable = (typeof REQUEST_IDENTITY_TEMPLATE_VARIABLES)[number];

/** Credential and transport headers: never templated, and never shown in an observation. */
export const REQUEST_IDENTITY_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'accept-encoding',
]);

const FORBIDDEN_TEMPLATE_PARAMS = new Set([
  'model',
  'messages',
  'input',
  'tools',
  'stream',
  'system',
  'instructions',
  'prompt_cache_key',
  'client_metadata',
  'metadata',
]);

export interface RequestIdentityTrackSeed {
  readonly id: RequestIdentityTrackId;
  readonly npmPackage: string;
  readonly cliCommand: string;
  readonly builtin: RequestIdentityTrackRevision;
}

const SEEDED_AT = '2026-09-30T00:00:00.000Z';

/** Upstream client versions shipped with this Kiki build. */
export const REQUEST_IDENTITY_TRACK_SEEDS: readonly RequestIdentityTrackSeed[] = [
  {
    id: 'codex_cli',
    npmPackage: '@openai/codex',
    cliCommand: 'codex',
    builtin: { version: '0.159.2', origin: 'builtin', source_detail: '@openai/codex', at: SEEDED_AT },
  },
  {
    id: 'claude_code',
    npmPackage: '@anthropic-ai/claude-code',
    cliCommand: 'claude',
    builtin: { version: '2.1.285', origin: 'builtin', source_detail: '@anthropic-ai/claude-code', at: SEEDED_AT },
  },
  {
    id: 'grok_cli',
    npmPackage: '@xai-official/grok',
    cliCommand: 'grok',
    builtin: { version: '1.0.44', origin: 'builtin', source_detail: '@xai-official/grok', at: SEEDED_AT },
  },
  {
    id: 'opencode_cli',
    npmPackage: 'opencode-ai',
    cliCommand: 'opencode',
    builtin: { version: '1.18.21', origin: 'builtin', source_detail: 'opencode-ai', at: SEEDED_AT },
  },
];

export const BUILTIN_REQUEST_IDENTITY_PROFILES: readonly RequestIdentityProfile[] = [
  {
    id: 'kimi_code',
    builtin: true,
    label: 'Kimi Code',
    base_preset: 'kimi_code',
    track: null,
    version: { mode: 'kiki' },
    user_agent: '',
    headers: [],
    params: [],
  },
  {
    id: 'codex',
    builtin: true,
    label: 'Codex CLI',
    base_preset: 'codex_compatible',
    track: 'codex_cli',
    version: { mode: 'track' },
    user_agent: 'codex_cli_rs/{version} ({os_type} {os_version}; {arch})',
    headers: [
      { name: 'originator', value: 'codex_cli_rs' },
      { name: 'version', value: '{version}' },
    ],
    params: [],
  },
  {
    id: 'claude_code',
    builtin: true,
    label: 'Claude Code',
    base_preset: 'claude_code_compatible',
    track: 'claude_code',
    version: { mode: 'track' },
    user_agent: 'claude-cli/{version} (external, cli)',
    headers: [
      { name: 'x-app', value: 'cli' },
      { name: 'anthropic-dangerous-direct-browser-access', value: 'true' },
      { name: 'X-Stainless-Lang', value: 'js' },
      { name: 'X-Stainless-Package-Version', value: '0.94.0' },
      { name: 'X-Stainless-OS', value: '{stainless_os}' },
      { name: 'X-Stainless-Arch', value: '{stainless_arch}' },
      { name: 'X-Stainless-Runtime', value: 'node' },
      { name: 'X-Stainless-Runtime-Version', value: 'v26.3.0' },
      { name: 'X-Stainless-Retry-Count', value: '0' },
      { name: 'X-Stainless-Timeout', value: '600' },
    ],
    params: [],
  },
  {
    id: 'grok_build',
    builtin: true,
    label: 'Grok Build',
    base_preset: 'grok_build_compatible',
    track: 'grok_cli',
    version: { mode: 'track' },
    user_agent: 'grok-shell/{version} ({grok_os}; {grok_arch})',
    headers: [
      { name: 'x-grok-client-identifier', value: 'grok-shell' },
      { name: 'x-grok-client-version', value: '{version}' },
    ],
    params: [],
  },
  {
    id: 'opencode',
    builtin: true,
    label: 'OpenCode',
    base_preset: 'opencode_compatible',
    track: 'opencode_cli',
    version: { mode: 'track' },
    user_agent: 'opencode/{version}',
    headers: [{ name: 'x-opencode-client', value: 'cli' }],
    params: [],
  },
  {
    id: 'none',
    builtin: true,
    label: 'None',
    base_preset: 'none',
    track: null,
    version: { mode: 'kiki' },
    user_agent: '',
    headers: [],
    params: [],
  },
];

export function builtinRequestIdentityProfile(id: string): RequestIdentityProfile | undefined {
  return BUILTIN_REQUEST_IDENTITY_PROFILES.find((profile) => profile.id === id);
}

export function requestIdentityProfileAxes(profile: RequestIdentityProfileDraft): RequestIdentityProfileAxes {
  return { preset: profile.base_preset, overrides: requestIdentityFromWire({ overrides: profile.overrides }).overrides };
}

export function templateVariables(template: string): string[] {
  return [...template.matchAll(/\{([^{}]*)\}/gu)].map((match) => match[1] ?? '');
}

/**
 * Reject what a request could not honestly send: unknown placeholders, credential or transport
 * headers, duplicated names, and body fields that the model request already owns.
 */
export function validateRequestIdentityProfileDraft(draft: RequestIdentityProfileDraft): void {
  const templates: string[] = [draft.user_agent, ...draft.headers.map((header) => header.value)];
  for (const param of draft.params) {
    if (typeof param.value === 'string') templates.push(param.value);
  }
  for (const template of templates) {
    for (const name of templateVariables(template)) {
      if (!(REQUEST_IDENTITY_TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
        throw invalid(`unknown template variable {${name}}`);
      }
    }
  }
  const seen = new Set<string>();
  for (const header of draft.headers) {
    const name = header.name.toLowerCase();
    if (REQUEST_IDENTITY_CREDENTIAL_HEADERS.has(name) || name.startsWith('x-kiki-')) {
      throw invalid(`header ${header.name} is managed by the provider connection`);
    }
    if (name === 'user-agent') throw invalid('set User-Agent in the User-Agent field');
    if (seen.has(name)) throw invalid(`header ${header.name} is listed twice`);
    seen.add(name);
  }
  const params = new Set<string>();
  for (const param of draft.params) {
    const name = param.name.toLowerCase();
    if (FORBIDDEN_TEMPLATE_PARAMS.has(name) || name.startsWith('x-kiki-')) {
      throw invalid(`body field ${param.name} is owned by the model request`);
    }
    if (params.has(name)) throw invalid(`body field ${param.name} is listed twice`);
    params.add(name);
  }
  if (draft.base_preset === 'none' && (draft.user_agent !== '' || draft.headers.length > 0 || draft.params.length > 0)) {
    throw invalid('the none identity sends no client fields; duplicate another identity to add them');
  }
  if (draft.version.mode === 'track' && draft.track === null) {
    throw invalid('version mode track needs a release track');
  }
}

export interface RequestIdentityRenderContext {
  readonly kikiVersion: string;
  readonly model: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly osRelease: string;
}

export interface RenderedRequestIdentityProfile {
  readonly profileId: string;
  readonly version: string;
  readonly versionOrigin: string;
  /** Undefined keeps the base identity's native User-Agent. */
  readonly userAgent?: string;
  /** Empty value = remove the header. */
  readonly headers: readonly RequestIdentityHeader[];
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Built-in profiles following a track take any template replacements the applied track revision
 * carries; custom profiles own their templates and only receive `{version}`.
 */
export function renderRequestIdentityProfile(
  profile: RequestIdentityProfile,
  trackCurrent: RequestIdentityTrackRevision | undefined,
  context: RequestIdentityRenderContext,
): RenderedRequestIdentityProfile {
  const { version, origin } = profileVersion(profile, trackCurrent, context.kikiVersion);
  const followTrackTemplates = profile.builtin && profile.version.mode === 'track' && trackCurrent !== undefined;
  const userAgentTemplate = followTrackTemplates && trackCurrent.user_agent !== undefined
    ? trackCurrent.user_agent
    : profile.user_agent;
  const headerTemplates = followTrackTemplates && trackCurrent.headers !== undefined
    ? mergeHeaderTemplates(profile.headers, trackCurrent.headers)
    : profile.headers;
  const variables = templateValues(version, context);
  const params: Record<string, string | number | boolean> = {};
  for (const param of profile.params) {
    params[param.name] = typeof param.value === 'string' ? renderTemplate(param.value, variables) : param.value;
  }
  return {
    profileId: profile.id,
    version,
    versionOrigin: origin,
    userAgent: userAgentTemplate === '' ? undefined : renderTemplate(userAgentTemplate, variables),
    headers: headerTemplates.map((header) => ({ name: header.name, value: renderTemplate(header.value, variables) })),
    params,
  };
}

function profileVersion(
  profile: RequestIdentityProfile,
  trackCurrent: RequestIdentityTrackRevision | undefined,
  kikiVersion: string,
): { version: string; origin: string } {
  if (profile.version.mode === 'fixed') return { version: profile.version.value, origin: 'fixed' };
  if (profile.version.mode === 'track' && trackCurrent !== undefined) {
    return { version: trackCurrent.version, origin: `track:${trackCurrent.origin}` };
  }
  return { version: kikiVersion, origin: 'kiki' };
}

function mergeHeaderTemplates(
  base: readonly RequestIdentityHeader[],
  patch: readonly RequestIdentityHeader[],
): RequestIdentityHeader[] {
  const merged = base.map((header) => ({ ...header }));
  for (const header of patch) {
    const index = merged.findIndex((candidate) => candidate.name.toLowerCase() === header.name.toLowerCase());
    if (index === -1) merged.push({ ...header });
    else merged[index] = { ...header };
  }
  return merged;
}

function templateValues(
  version: string,
  context: RequestIdentityRenderContext,
): Record<RequestIdentityTemplateVariable, string> {
  return {
    version,
    kiki_version: context.kikiVersion,
    model: context.model,
    os_type: context.platform === 'win32' ? 'Windows' : context.platform === 'darwin' ? 'Mac OS' : context.platform === 'linux' ? 'Linux' : context.platform,
    os_version: context.osRelease,
    arch: context.arch === 'x64' ? 'x86_64' : context.arch === 'ia32' ? 'x86' : context.arch,
    platform: context.platform,
    node_arch: context.arch,
    stainless_os: context.platform === 'win32' ? 'Windows' : context.platform === 'darwin' ? 'MacOS' : context.platform === 'linux' ? 'Linux' : `Other:${context.platform}`,
    stainless_arch: context.arch,
    grok_os: context.platform === 'win32' ? 'windows' : context.platform === 'darwin' ? 'macos' : context.platform,
    grok_arch: context.arch === 'x64' ? 'x86_64' : context.arch === 'arm64' ? 'aarch64' : context.arch,
  };
}

export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template
    .replaceAll(/\{([^{}]*)\}/gu, (whole, name: string) => values[name] ?? whole)
    .replaceAll(/[^\u0020-\u007E]/gu, '')
    .trim();
}

function invalid(message: string): Error2 {
  return new Error2(RequestIdentityErrors.codes.REQUEST_IDENTITY_INVALID, message);
}
