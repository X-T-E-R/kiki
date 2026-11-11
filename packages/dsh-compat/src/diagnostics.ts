import type { AnyCordisPlugin } from '@kiki/cordis-runtime';

import type {
  DshCompatIncompatibilityCode,
  DshPluginCompatibilityReport,
} from './index';

/** Structured load-time diagnostic emitted when module resolution intercepts an unsupported seam or missing external dependency. */
export interface DshCompatLoadDiagnostic {
  readonly code: DshCompatIncompatibilityCode;
  readonly kind: 'unsupported_seam' | 'missing_external_dependency' | 'abi_mismatch';
  readonly specifier: string;
  readonly importerUrl?: string;
  readonly serviceName?: string;
  readonly message: string;
  readonly remediation: string;
}

/** Error raised by module resolution or plugin inspection when a DSH plugin crosses the compatibility boundary. */
export class DshCompatError extends Error {
  readonly code: DshCompatIncompatibilityCode;
  readonly serviceName?: string;
  readonly diagnostic?: DshCompatLoadDiagnostic;
  readonly report?: DshPluginCompatibilityReport;

  constructor(
    code: DshCompatIncompatibilityCode,
    message: string,
    options: {
      serviceName?: string;
      diagnostic?: DshCompatLoadDiagnostic;
      report?: DshPluginCompatibilityReport;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DshCompatError';
    this.code = code;
    this.serviceName = options.serviceName;
    this.diagnostic = options.diagnostic;
    this.report = options.report;
  }
}

export interface UnsupportedSeamRule {
  readonly code: DshCompatIncompatibilityCode;
  readonly specifiers: readonly (string | RegExp)[];
  readonly sourcePattern: RegExp;
  readonly serviceName?: string;
  readonly message: string;
  readonly remediation: string;
}

export const UNSUPPORTED_SEAMS: readonly UnsupportedSeamRule[] = [
  {
    code: 'DSH_COMPAT_SESSION_SURFACE_UNSUPPORTED',
    specifiers: [
      /^@deepseek-ai\/dsh-compaction(?:-|$|\/)/,
      /^dsh\.compaction$/,
    ],
    sourcePattern: /(?:session\.surface|\.surface\.replaceGeneration|compactSurfaceRegion|@deepseek-ai\/dsh-compaction(?:\/|\s|['"]))/,
    serviceName: 'sessions',
    message: 'The package requires DSH Session.surface generation replacement, which the narrow host bridge does not expose.',
    remediation: 'Use Kiki E6 CompactionPolicyContribution instead of mounting a DSH surface-rewriting compaction backend.',
  },
  {
    code: 'DSH_COMPAT_SESSION_PROJECTION_UNSUPPORTED',
    specifiers: [
      /^@deepseek-ai\/dsh-session-projection(?:-|$|\/)/,
      /^dsh\.sessionProjections$/,
    ],
    sourcePattern: /(?:sessionProjections|@deepseek-ai\/dsh-session-projection)/,
    serviceName: 'sessionProjections',
    message: 'The package requires synchronous DSH session projection registration and folding.',
    remediation: 'Use Kiki E11 durable plugin state instead of mounting a projection-owning DSH package.',
  },
  {
    code: 'DSH_COMPAT_SUBAGENT_PRESET_UNSUPPORTED',
    specifiers: [
      /^@deepseek-ai\/dsh-subagent(?:-|$|\/)/,
      /^@deepseek-ai\/dsh-agent-preset-registry(?:-|$|\/)/,
      /^dsh\.subagents$/,
    ],
    sourcePattern: /(?:agentPresets|SubagentPresetSelection|@deepseek-ai\/dsh-subagent|ctx\.subagents)/,
    serviceName: 'subagents',
    message: 'The package requires the complete DSH subagent provider and Agent Preset tree.',
    remediation: 'Delegate through Kiki E9 and the native Agent profile catalog; do not partially mount the DSH preset tree.',
  },
  {
    code: 'DSH_COMPAT_CLIENT_UI_BUNDLE_UNSUPPORTED',
    specifiers: [
      /^@deepseek-ai\/dsh-client(?:-|$|\/)/,
      /^@deepseek-ai\/dsh-experimental-client-ui(?:-|$|\/)/,
      /^dsh\.client$/,
    ],
    sourcePattern: /(?:@deepseek-ai\/dsh-client|\.tsx['"]|client\/ui-)/,
    message: 'The package includes a DSH client UI bundle rather than an in-process capability plugin.',
    remediation: 'Port the UI to a declarative Kiki E12 contribution.',
  },
  {
    code: 'DSH_COMPAT_SANDBOX_POLICY_UNSUPPORTED',
    specifiers: [
      /^@deepseek-ai\/dsh-sandbox(?:-|$|\/)/,
      /^dsh\.sandbox$/,
    ],
    sourcePattern: /(?:sandboxPolicy|@deepseek-ai\/dsh-sandbox-policy)/,
    serviceName: 'sandboxPolicy',
    message: 'The package requires DSH sandbox policy resolution outside the approved host execution boundary.',
    remediation: 'Declare the corresponding Kiki process and workspace permissions explicitly.',
  },
  {
    code: 'DSH_COMPAT_MISSING_REQUIRED_SERVICE',
    specifiers: [
      /^@deepseek-ai\/dsh-api(?:-|$|\/)/,
      /^@deepseek-ai\/dsh-database(?:-|$|\/)/,
      /^@deepseek-ai\/dsh-storage-sqlite(?:-|$|\/)/,
      /^dsh\.api(?:\.|$)/,
      /^dsh\.database(?:\.|$)/,
    ],
    sourcePattern: /(?:@deepseek-ai\/dsh-api(?:\/|-|['"])|@deepseek-ai\/dsh-database(?:\/|-|['"])|\bctx\.(?:api|database)\b)/,
    serviceName: 'dsh.api/database',
    message: 'The package targets unsupported DSH server BFF or database seams (dsh.api / dsh.database).',
    remediation: 'Route HTTP/WS endpoints through Kiki E12 broker routes and persist state through Kiki storage services.',
  },
];

export function matchUnsupportedSeamSpecifier(
  specifier: string,
  importerUrl?: string,
): DshCompatLoadDiagnostic | undefined {
  for (const rule of UNSUPPORTED_SEAMS) {
    const matched = rule.specifiers.some(entry =>
      typeof entry === 'string' ? entry === specifier : entry.test(specifier),
    );
    if (!matched) continue;
    return {
      code: rule.code,
      kind: 'unsupported_seam',
      specifier,
      importerUrl,
      serviceName: rule.serviceName,
      message: `${rule.message} (imported "${specifier}"${importerUrl ? ` from ${importerUrl}` : ''})`,
      remediation: rule.remediation,
    };
  }
  return undefined;
}

export function createMissingExternalDependencyDiagnostic(
  specifier: string,
  importerUrl?: string,
): DshCompatLoadDiagnostic {
  const packageName = parseBarePackageName(specifier) ?? specifier;
  return {
    code: 'DSH_COMPAT_MISSING_REQUIRED_SERVICE',
    kind: 'missing_external_dependency',
    specifier,
    importerUrl,
    serviceName: packageName,
    message: `External npm dependency "${packageName}" required by specifier "${specifier}" is not installed in the host workspace${importerUrl ? ` (imported from ${importerUrl})` : ''}.`,
    remediation: `Install "${packageName}" in the plugin or host dependencies instead of shimming incompatible package versions.`,
  };
}

export function parseBarePackageName(specifier: string): string | undefined {
  if (
    specifier === ''
    || specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('#')
    || specifier.includes(':')
  ) {
    return undefined;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  const slash = specifier.indexOf('/');
  return slash < 0 ? specifier : specifier.slice(0, slash);
}

export function inspectDshPluginSource(
  source: string,
  packageMeta: { readonly name: string; readonly version?: string },
  inject: readonly string[] = [],
  availableServices: ReadonlySet<string> = new Set(),
): DshPluginCompatibilityReport {
  const diagnostics: {
    code: DshCompatIncompatibilityCode;
    severity: 'error' | 'warn';
    serviceName?: string;
    message: string;
    remediation: string;
  }[] = [];
  const seenCodes = new Set<string>();
  for (const rule of UNSUPPORTED_SEAMS) {
    if (!rule.sourcePattern.test(source)) continue;
    const dedupKey = `${rule.code}:${rule.serviceName ?? ''}`;
    if (seenCodes.has(dedupKey)) continue;
    seenCodes.add(dedupKey);
    diagnostics.push({
      code: rule.code,
      severity: 'error',
      serviceName: rule.serviceName,
      message: rule.message,
      remediation: rule.remediation,
    });
  }
  const specialServiceRule: Readonly<Record<string, { code: DshCompatIncompatibilityCode; message: string; remediation: string }>> = {
    sessions: {
      code: 'DSH_COMPAT_SESSION_SURFACE_UNSUPPORTED',
      message: 'The package injects DSH "sessions" surface management, which is not exposed in-process.',
      remediation: 'Use Kiki session/compaction extension slots instead of direct DSH Session.surface access.',
    },
    sessionProjections: {
      code: 'DSH_COMPAT_SESSION_PROJECTION_UNSUPPORTED',
      message: 'The package injects "sessionProjections", which is not supported by the narrow bridge.',
      remediation: 'Use Kiki E11 durable plugin state instead of DSH sessionProjections.',
    },
    subagents: {
      code: 'DSH_COMPAT_SUBAGENT_PRESET_UNSUPPORTED',
      message: 'The package injects DSH "subagents" / preset tree.',
      remediation: 'Delegate through Kiki E9 subagent dispatch hooks.',
    },
    agentPresets: {
      code: 'DSH_COMPAT_SUBAGENT_PRESET_UNSUPPORTED',
      message: 'The package injects DSH "agentPresets".',
      remediation: 'Use Kiki native Agent profile catalog.',
    },
    sandboxPolicy: {
      code: 'DSH_COMPAT_SANDBOX_POLICY_UNSUPPORTED',
      message: 'The package injects DSH "sandboxPolicy".',
      remediation: 'Declare host process and filesystem permissions explicitly in Kiki.',
    },
    client: {
      code: 'DSH_COMPAT_CLIENT_UI_BUNDLE_UNSUPPORTED',
      message: 'The package injects DSH "client" UI host service, which is unsupported in Kiki.',
      remediation: 'Author Kiki GUI contributions through E10 panel/slash/status contracts.',
    },
  };
  for (const serviceName of inject) {
    if (availableServices.has(serviceName)) continue;
    const mapped = specialServiceRule[serviceName];
    if (mapped !== undefined) {
      const dedupKey = `${mapped.code}:${serviceName}`;
      if (!seenCodes.has(dedupKey)) {
        seenCodes.add(dedupKey);
        diagnostics.push({
          code: mapped.code,
          severity: 'error',
          serviceName,
          message: mapped.message,
          remediation: mapped.remediation,
        });
      }
      continue;
    }
    diagnostics.push({
      code: 'DSH_COMPAT_MISSING_REQUIRED_SERVICE',
      severity: 'error',
      serviceName,
      message: `Required DSH service "${serviceName}" is not installed in the compatibility context.`,
      remediation: `Install a host-backed "${serviceName}" port before mounting ${packageMeta.name}.`,
    });
  }
  const typert = /(?:typert|TypertRemoteService)/.test(source);
  const hasError = diagnostics.some(diagnostic => diagnostic.severity === 'error');
  return {
    packageName: packageMeta.name,
    packageVersion: packageMeta.version,
    compatible: !hasError,
    mode: hasError ? 'rejected' : typert ? 'degraded-typert-broker' : 'native-shim',
    injectedServices: inject,
    diagnostics,
  };
}

export function inspectDshPlugin(
  plugin: AnyCordisPlugin,
  packageMeta: { readonly name: string; readonly version?: string },
  availableServices: ReadonlySet<string>,
): DshPluginCompatibilityReport {
  const declared = (plugin as {
    inject?: readonly string[] | Readonly<Record<string, { readonly required?: boolean }>>;
  }).inject;
  const inject = Array.isArray(declared)
    ? declared
    : Object.entries(declared ?? {})
      .filter(([, value]) => value.required !== false)
      .map(([key]) => key);
  const candidate: unknown = plugin;
  const entry = typeof candidate === 'object' && candidate !== null && 'apply' in candidate
    ? candidate.apply
    : candidate;
  const source = typeof entry === 'function' ? Function.prototype.toString.call(entry) : '';
  return inspectDshPluginSource(source, packageMeta, inject, availableServices);
}
