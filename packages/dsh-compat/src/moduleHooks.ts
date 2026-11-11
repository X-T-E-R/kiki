import { realpathSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  cordis as cordisNamespace,
  cosmokit as cosmokitNamespace,
  schemastery as schemasteryNamespace,
  scope as scopeNamespace,
} from '@kiki/cordis-runtime';
import * as attachmentNamespace from './vendor/attachment/src/index';
import * as brandNamespace from './vendor/brand/src/index';
import * as llmBrandNamespace from './vendor/llm/src/brand';
import * as llmErrorNamespace from './vendor/llm/src/error';
import * as llmMessageNamespace from './vendor/llm/src/message';
import * as llmTypesNamespace from './vendor/llm/src/types';
import * as lspNamespace from './vendor/lsp/src/index';
import * as systemPromptNamespace from './vendor/system-prompt/src/index';
import * as timeoutNamespace from './vendor/timeout/src/index';
import * as utilCryptoNamespace from './vendor/util-crypto/src/index';
import * as utilValuesNamespace from './vendor/util-values/src/index';
import {
  createMissingExternalDependencyDiagnostic,
  DshCompatError,
  type DshCompatLoadDiagnostic,
  matchUnsupportedSeamSpecifier,
  parseBarePackageName,
} from './diagnostics';
import * as agentSessionSurface from './dshAgentSessionSurface';
import * as llmSurface from './dshLlmSurface';
import * as toolsSurface from './dshToolsSurface';
import * as typertSurface from './dshTypertSurface';
import type { DshModuleHookOptions } from './index';

export interface InstalledDshModuleHooks {
  readonly diagnostics: readonly DshCompatLoadDiagnostic[];
  clearDiagnostics(): void;
  dispose(): void;
}

const REGISTRY_SYMBOL = Symbol.for('@kiki/dsh-compat/canonical-surfaces');

const CANONICAL_SURFACE_NAMESPACES: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  '@deepseek-ai/cordis': cordisNamespace,
  '@deepseek-ai/cosmokit': cosmokitNamespace,
  '@deepseek-ai/schemastery': schemasteryNamespace,
  '@deepseek-ai/dsh-scope': scopeNamespace,
  '@deepseek-ai/dsh-system-prompt': systemPromptNamespace,
  '@deepseek-ai/dsh-brand': brandNamespace,
  '@deepseek-ai/dsh-util-crypto': utilCryptoNamespace,
  '@deepseek-ai/dsh-util-values': utilValuesNamespace,
  '@deepseek-ai/dsh-timeout': timeoutNamespace,
  '@deepseek-ai/dsh-attachment': attachmentNamespace,
  '@deepseek-ai/dsh-lsp': lspNamespace,
  '@deepseek-ai/dsh-llm': llmSurface,
  '@deepseek-ai/dsh-llm/brand': llmBrandNamespace,
  '@deepseek-ai/dsh-llm/error': llmErrorNamespace,
  '@deepseek-ai/dsh-llm/message': llmMessageNamespace,
  '@deepseek-ai/dsh-llm/types': llmTypesNamespace,
  '@deepseek-ai/dsh-tools': toolsSurface,
  '@deepseek-ai/dsh-agent': agentSessionSurface,
  '@deepseek-ai/dsh-session': agentSessionSurface,
  '@deepseek-ai/dsh-session/types': agentSessionSurface,
  '@deepseek-ai/dsh-fs': agentSessionSurface,
  '@deepseek-ai/dsh-subprocess': agentSessionSurface,
  '@deepseek-ai/dsh-working-directory': agentSessionSurface,
  '@deepseek-ai/dsh-mcp-resources': agentSessionSurface,
  '@deepseek-ai/dsh-credentials': agentSessionSurface,
  '@deepseek-ai/dsh-settings': agentSessionSurface,
  '@deepseek-ai/dsh-typert-protocol': typertSurface,
  '@deepseek-ai/dsh-typert-registry': typertSurface,
  '@deepseek-ai/typert': typertSurface,
  '@deepseek-ai/typert-protocol': typertSurface,
  '@deepseek-ai/typert-registry': typertSurface,
});

const VIRTUAL_SCHEME_PREFIX = 'dsh-compat:surface/';
const IDENTIFIER_RE = /^[$A-Z_a-z][$\w]*$/;

function buildVirtualSurfaceModuleSource(surfaceKey: string, ns: Record<string, unknown>): string {
  const registryExpr = `globalThis[Symbol.for(${JSON.stringify('@kiki/dsh-compat/canonical-surfaces')})][${JSON.stringify(surfaceKey)}]`;
  const lines: string[] = [`const __ns = ${registryExpr};`];
  for (const key of Object.keys(ns)) {
    if (key === 'default') {
      lines.push('export default __ns.default;');
    } else if (IDENTIFIER_RE.test(key)) {
      lines.push(`export const ${key} = __ns.${key};`);
    }
  }
  return lines.join('\n');
}

const VIRTUAL_SURFACE_SOURCES = new Map<string, string>();
for (const [specifier, ns] of Object.entries(CANONICAL_SURFACE_NAMESPACES)) {
  VIRTUAL_SURFACE_SOURCES.set(
    `${VIRTUAL_SCHEME_PREFIX}${encodeURIComponent(specifier)}`,
    buildVirtualSurfaceModuleSource(specifier, ns),
  );
}

function surfaceVirtualUrl(specifier: string): string | undefined {
  if (!(specifier in CANONICAL_SURFACE_NAMESPACES)) return undefined;
  return `${VIRTUAL_SCHEME_PREFIX}${encodeURIComponent(specifier)}`;
}

/** Normalize a filesystem path across Windows drive-letter casing, slashes, and symlinks. */
export function normalizeFsRootPath(rawPath: string): string {
  const resolved = resolve(rawPath);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    canonical = resolved;
  }
  const forward = canonical.replaceAll('\\', '/').replace(/\/+$/, '');
  if (process.platform === 'win32') {
    return forward.toLowerCase();
  }
  return forward;
}

function parentUrlToNormalizedPath(parentURL: string | undefined): string | undefined {
  if (parentURL === undefined || !parentURL.startsWith('file:')) return undefined;
  try {
    const fsPath = fileURLToPath(parentURL);
    return normalizeFsRootPath(fsPath);
  } catch {
    return undefined;
  }
}

function isWithinNormalizedRoots(candidatePath: string, normalizedRoots: readonly string[]): boolean {
  if (normalizedRoots.length === 0) return true;
  for (const root of normalizedRoots) {
    if (candidatePath === root || candidatePath.startsWith(`${root}/`)) {
      return true;
    }
  }
  return false;
}

function normalizeOverrideTarget(target: string): string {
  if (target.startsWith('file:') || target.startsWith(VIRTUAL_SCHEME_PREFIX)) return target;
  const virtual = surfaceVirtualUrl(target);
  if (virtual !== undefined) return virtual;
  if (isAbsolute(target)) return pathToFileURL(target).href;
  return target;
}

function isModuleNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ERR_MODULE_NOT_FOUND'
    || code === 'MODULE_NOT_FOUND'
    || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  );
}

const NORMALIZED_COMPAT_PACKAGE_ROOT = normalizeFsRootPath(
  resolve(import.meta.dirname, '..'),
);

const globals = globalThis as Record<symbol, unknown>;

export function assertDshModuleAbi(): void {
  const existing = globals[REGISTRY_SYMBOL] as typeof CANONICAL_SURFACE_NAMESPACES | undefined;
  if (existing !== undefined && existing['@deepseek-ai/cordis']?.['Context'] !== cordisNamespace.Context) {
    const diagnostic: DshCompatLoadDiagnostic = {
      code: 'DSH_COMPAT_ABI_MISMATCH',
      kind: 'abi_mismatch',
      specifier: '@deepseek-ai/cordis',
      message: 'Another @kiki/dsh-compat copy already owns the canonical Cordis ABI in this process.',
      remediation: 'Use the existing compatibility environment; do not mix source, bundled, or duplicate package instances.',
    };
    throw new DshCompatError(diagnostic.code, diagnostic.message, { diagnostic });
  }
}

/** Install synchronous Node 24 hooks for the canonical ABI and structured load diagnostics. */
export function installDshModuleHooks(options: DshModuleHookOptions): InstalledDshModuleHooks {
  assertDshModuleAbi();
  globals[REGISTRY_SYMBOL] = CANONICAL_SURFACE_NAMESPACES;
  const normalizedPluginRoots = options.pluginRoots.map(root => normalizeFsRootPath(root));
  const customRedirects = new Map<string, string>();
  for (const [key, value] of Object.entries(options.redirectPackages ?? {})) {
    customRedirects.set(key, normalizeOverrideTarget(value));
  }
  const recordedDiagnostics: DshCompatLoadDiagnostic[] = [];

  const shouldInterceptImporter = (parentURL: string | undefined): boolean => {
    if (parentURL === undefined) return true;
    if (parentURL.startsWith(VIRTUAL_SCHEME_PREFIX)) return true;
    const importerPath = parentUrlToNormalizedPath(parentURL);
    if (importerPath === undefined) return false;
    if (isWithinNormalizedRoots(importerPath, [NORMALIZED_COMPAT_PACKAGE_ROOT])) return true;
    return isWithinNormalizedRoots(importerPath, normalizedPluginRoots);
  };

  const registration = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(VIRTUAL_SCHEME_PREFIX)) {
        return { url: specifier, shortCircuit: true };
      }
      if (isBuiltin(specifier)) {
        return nextResolve(specifier, context);
      }
      const intercept = shouldInterceptImporter(context.parentURL);
      if (!intercept) {
        return nextResolve(specifier, context);
      }

      const customTarget = customRedirects.get(specifier);
      if (customTarget !== undefined) {
        if (customTarget.startsWith('file:') || customTarget.startsWith(VIRTUAL_SCHEME_PREFIX)) {
          return { url: customTarget, shortCircuit: true };
        }
        return nextResolve(customTarget, context);
      }

      const unsupported = matchUnsupportedSeamSpecifier(specifier, context.parentURL);
      if (unsupported !== undefined) {
        recordedDiagnostics.push(unsupported);
        throw new DshCompatError(unsupported.code, unsupported.message, {
          serviceName: unsupported.serviceName,
          diagnostic: unsupported,
        });
      }

      const virtualTarget = surfaceVirtualUrl(specifier);
      if (virtualTarget !== undefined) {
        return { url: virtualTarget, shortCircuit: true };
      }

      if (specifier.startsWith('@deepseek-ai/typert')) {
        const typertUrl = surfaceVirtualUrl('@deepseek-ai/dsh-typert-protocol')!;
        return { url: typertUrl, shortCircuit: true };
      }

      if (specifier.startsWith('@deepseek-ai/dsh-')) {
        const missingSeam: DshCompatLoadDiagnostic = {
          code: 'DSH_COMPAT_MISSING_REQUIRED_SERVICE',
          kind: 'unsupported_seam',
          specifier,
          importerUrl: context.parentURL,
          serviceName: specifier,
          message: `DSH package "${specifier}" is not bridged by @kiki/dsh-compat${context.parentURL ? ` (imported from ${context.parentURL})` : ''}.`,
          remediation: 'Check the supported DSH capability list or expose an explicit host adapter.',
        };
        recordedDiagnostics.push(missingSeam);
        throw new DshCompatError(missingSeam.code, missingSeam.message, {
          serviceName: missingSeam.serviceName,
          diagnostic: missingSeam,
        });
      }

      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const barePkg = parseBarePackageName(specifier);
        if (barePkg !== undefined && isModuleNotFoundError(error)) {
          const diagnostic = createMissingExternalDependencyDiagnostic(specifier, context.parentURL);
          recordedDiagnostics.push(diagnostic);
          throw new DshCompatError(diagnostic.code, diagnostic.message, {
            serviceName: diagnostic.serviceName,
            diagnostic,
            cause: error,
          });
        }
        throw error;
      }
    },
    load(url, context, nextLoad) {
      const virtualSource = VIRTUAL_SURFACE_SOURCES.get(url);
      if (virtualSource !== undefined) {
        return {
          format: 'module',
          source: virtualSource,
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });

  let disposed = false;
  return {
    get diagnostics() {
      return [...recordedDiagnostics];
    },
    clearDiagnostics() {
      recordedDiagnostics.length = 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      registration.deregister();
    },
  };
}
