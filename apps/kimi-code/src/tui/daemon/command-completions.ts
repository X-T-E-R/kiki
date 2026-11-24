/**
 * Complete argument & multi-stage completion providers for all 28 argument-bearing
 * daemon slash commands, adhering strictly to the Frame Audit §4 contract:
 *
 * - Finite choices (`model`, `effort`, `permission`, `theme`, `mouse`, `screen`,
 *   `agent`, `agent-transcript`, `login`, `copy`): prefix-ranked + frecency tie-break,
 *   `CURRENT_MARK` on active value, `intent: 'runOnEnter'` on safe terminal picks.
 * - Consequential actions (`logout`, `plugins enable/disable/remove/install`,
 *   `tasks stop`, `provider remove`, `web revoke`, `settings`): `intent: 'insert'`
 *   so selecting a suggestion never mutates state before an explicit Enter.
 * - Intermediate stages & directories: `intent: 'continue'` with separator so the
 *   next slot opens automatically.
 * - Freeform-guarded commands (`goal`, `branch`): never hijack Enter on typing;
 *   only open completion menu on explicit `Tab`.
 */

import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { sortThinkingEffortsForDisplay } from '@kiki/session-core/settings/thinkingEffort';
import type { AutocompleteItem } from '@kiki/pi-tui';
import type { ModelAlias } from '@kiki/node-sdk';
import type { ExecutorCatalogItem } from '@kiki/protocol';

import type {
  SlashArgumentCompleter,
  SlashArgumentContext,
  SlashArgumentHintProvider,
} from '#/tui/components/editor/file-mention-provider';
import { CURRENT_MARK } from '#/tui/constant/symbols';
import { listCustomThemesSync } from '#/tui/theme/custom-theme-loader';
import {
  buildLoginArgumentCompletions,
  buildModelArgumentCompletions,
  executorThinkingLevelsForModel,
  type ResolvedExecutorModels,
} from './executor-models';

export interface CachedPluginEntry {
  readonly id: string;
  readonly name?: string;
  readonly enabled: boolean;
}

export interface CachedTaskEntry {
  readonly id: string;
  readonly status: string;
  readonly description?: string;
}

export interface CachedPersonaEntry {
  readonly id: string;
  readonly name: string;
}

export interface CachedProviderEntry {
  readonly id: string;
  readonly authSupported?: boolean;
  readonly authenticated?: boolean;
  readonly description?: string;
}

export interface CachedAgentEntry {
  readonly id: string;
  readonly label: string;
  readonly status?: string;
}

export interface CachedCopyCandidate {
  readonly index: number;
  readonly preview: string;
}

export type LazyCompletionResource =
  | 'plugins'
  | 'tasks'
  | 'personas'
  | 'providers'
  | 'configDomains'
  | 'webSessions';

export interface DaemonCompletionSnapshot {
  readonly workDir: string;
  readonly currentModel: string;
  readonly availableModels: Record<string, ModelAlias>;
  readonly recentModels: readonly string[];
  readonly currentThinkingEffort: string;
  readonly currentPermissionMode: string;
  readonly currentTheme: string;
  readonly effectiveMouse: boolean;
  readonly screenMode: 'main' | 'alt';
  readonly currentAgentProfile?: string;
  readonly availableAgentProfiles: readonly { readonly name: string; readonly description?: string }[];
  readonly focusedAgentId: string;
  readonly sessionAgents: readonly CachedAgentEntry[];
  readonly plugins: readonly CachedPluginEntry[];
  readonly tasks: readonly CachedTaskEntry[];
  readonly personas: readonly CachedPersonaEntry[];
  readonly providers: readonly CachedProviderEntry[];
  readonly configDomains: readonly string[];
  readonly webSessionIds: readonly string[];
  readonly goalStatus?: 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  readonly copyCandidates: readonly CachedCopyCandidate[];
  readonly sessionId?: string;
  readonly externalModels?: ResolvedExecutorModels;
  readonly executorCatalog?: readonly ExecutorCatalogItem[];
  readonly pendingAntigravityLogin?: boolean;
  readonly requestLazyRefresh: (resource: LazyCompletionResource) => void;
}

function rankByPrefixAndFrecency<T>(
  items: readonly T[],
  query: string,
  getKey: (item: T) => string,
  getSearchText: (item: T) => string,
  frecencyOrder?: readonly string[],
): T[] {
  const q = query.trim().toLowerCase();
  const frecencyRank = new Map<string, number>(
    (frecencyOrder ?? []).map((id, idx) => [id.toLowerCase(), idx]),
  );
  const scored: Array<{ readonly item: T; readonly tier: number; readonly frecency: number; readonly key: string }> = [];
  for (const item of items) {
    const key = getKey(item);
    const keyLower = key.toLowerCase();
    const searchLower = getSearchText(item).toLowerCase();
    if (q.length === 0) {
      scored.push({ item, tier: 0, frecency: frecencyRank.get(keyLower) ?? 9999, key });
      continue;
    }
    if (keyLower === q) {
      scored.push({ item, tier: 0, frecency: frecencyRank.get(keyLower) ?? 9999, key });
    } else if (keyLower.startsWith(q)) {
      scored.push({ item, tier: 1, frecency: frecencyRank.get(keyLower) ?? 9999, key });
    } else if (searchLower.includes(q)) {
      scored.push({ item, tier: 2, frecency: frecencyRank.get(keyLower) ?? 9999, key });
    } else {
      // Subsequence fuzzy match
      let qi = 0;
      for (let i = 0; i < searchLower.length && qi < q.length; i += 1) {
        if (searchLower[i] === q[qi]) qi += 1;
      }
      if (qi === q.length) {
        scored.push({ item, tier: 3, frecency: frecencyRank.get(keyLower) ?? 9999, key });
      }
    }
  }
  scored.sort(
    (a, b) => a.tier - b.tier || a.frecency - b.frecency || a.key.localeCompare(b.key),
  );
  return scored.map((entry) => entry.item);
}

function listPathCompletions(
  workDir: string,
  currentToken: string,
  replaceStartCol?: number,
  replaceEndCol?: number,
): AutocompleteItem[] {
  try {
    const normalized = currentToken.replaceAll('\\', '/');
    const lastSlash = normalized.lastIndexOf('/');
    const dirPrefix = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '';
    const filePrefix = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
    const searchDir = dirPrefix.length > 0 ? resolve(workDir, dirPrefix) : workDir;
    const entries = readdirSync(searchDir, { withFileTypes: true });
    const filtered = entries
      .filter((entry) => {
        if (entry.name === '.git' || entry.name === 'node_modules') return false;
        if (filePrefix.length === 0) return !entry.name.startsWith('.');
        return entry.name.toLowerCase().startsWith(filePrefix.toLowerCase());
      })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 30);

    return filtered.map((entry) => {
      const isDir = entry.isDirectory();
      const rel = `${dirPrefix}${entry.name}${isDir ? '/' : ''}`;
      return {
        value: rel,
        label: `${entry.name}${isDir ? '/' : ''}`,
        description: join(dirname(resolve(workDir, rel)), entry.name),
        intent: isDir ? 'continue' : 'insert',
        replaceStartCol,
        replaceEndCol,
      };
    });
  } catch {
    return [];
  }
}

export function createDaemonArgumentCompletions(
  getSnapshot: () => DaemonCompletionSnapshot,
): {
  readonly argumentCompleters: ReadonlyMap<string, SlashArgumentCompleter>;
  readonly argumentHintProviders: ReadonlyMap<string, SlashArgumentHintProvider>;
} {
  const completers = new Map<string, SlashArgumentCompleter>();
  const hints = new Map<string, SlashArgumentHintProvider>();

  // 1. /model [model]
  completers.set('model', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    if (snap.externalModels !== undefined && snap.externalModels.models.length > 0) {
      return buildModelArgumentCompletions(ctx.currentToken, snap.externalModels, [])
        .slice(0, 40)
        .map((item) => ({
          ...item,
          label: `${item.label}${item.value === snap.currentModel ? CURRENT_MARK : ''}`,
          intent: 'runOnEnter' as const,
        }));
    }
    const entries = Object.entries(snap.availableModels).map(([alias, cfg]) => ({
      alias,
      provider: cfg.provider,
      model: cfg.model,
    }));
    const ranked = rankByPrefixAndFrecency(
      entries,
      ctx.currentToken,
      (e) => e.alias,
      (e) => `${e.alias} ${e.provider} ${e.model}`,
      snap.recentModels,
    );
    return ranked.slice(0, 40).map((e) => ({
      value: e.alias,
      label: `${e.alias}${e.alias === snap.currentModel ? CURRENT_MARK : ''}`,
      description: `${e.provider} · ${e.model}`,
      intent: 'runOnEnter',
    }));
  });

  // 2. /effort [effort]
  completers.set('effort', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    const externalLevels = snap.externalModels !== undefined
      ? executorThinkingLevelsForModel(snap.externalModels, snap.currentModel)
      : [];
    const activeCfg = snap.availableModels[snap.currentModel];
    const supported = activeCfg?.supportEfforts;
    const rawLevels: string[] =
      externalLevels.length > 0
        ? [...externalLevels]
        : Array.isArray(supported) && supported.length > 0
          ? ['off', ...sortThinkingEffortsForDisplay(supported)]
          : ['off', 'on'];
    const unique = [...new Set(rawLevels)];
    const ranked = rankByPrefixAndFrecency(unique, ctx.currentToken, (l) => l, (l) => l);
    return ranked.map((level) => ({
      value: level,
      label: `${level}${level === snap.currentThinkingEffort ? CURRENT_MARK : ''}`,
      description: level === 'off' ? 'Disable thinking' : `Set thinking effort to ${level}`,
      intent: 'runOnEnter',
    }));
  });

  // 3. /permission [manual|auto|review|yolo]
  completers.set('permission', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    const modes = [
      { id: 'manual', desc: 'Approve every tool call manually' },
      { id: 'auto', desc: 'Auto-approve safe workspace actions' },
      { id: 'review', desc: 'Approve writes & shell, auto-approve reads' },
      { id: 'yolo', desc: 'Auto-approve all tool calls' },
    ];
    return rankByPrefixAndFrecency(modes, ctx.currentToken, (m) => m.id, (m) => `${m.id} ${m.desc}`).map((m) => ({
      value: m.id,
      label: `${m.id}${m.id === snap.currentPermissionMode ? CURRENT_MARK : ''}`,
      description: m.desc,
      intent: 'runOnEnter',
    }));
  });

  // 4. /theme [auto|dark|light|<custom>]
  completers.set('theme', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    let custom: string[] = [];
    try {
      custom = listCustomThemesSync();
    } catch {
      custom = [];
    }
    const items = [
      { id: 'auto', desc: 'Match terminal background automatically' },
      { id: 'dark', desc: 'Built-in dark theme' },
      { id: 'light', desc: 'Built-in light theme' },
      ...custom.map((name) => ({ id: name, desc: 'Custom theme (~/.kiki/themes/)' })),
    ];
    return rankByPrefixAndFrecency(items, ctx.currentToken, (t) => t.id, (t) => `${t.id} ${t.desc}`).map((t) => ({
      value: t.id,
      label: `${t.id}${t.id === snap.currentTheme ? CURRENT_MARK : ''}`,
      description: t.desc,
      intent: 'runOnEnter',
    }));
  });

  // 5. /mouse [on|off]
  completers.set('mouse', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    const items = [
      { id: 'on', desc: 'Enable fullscreen SGR mouse scroll & click' },
      { id: 'off', desc: 'Disable SGR mouse capture for native selection' },
    ];
    const current = snap.effectiveMouse ? 'on' : 'off';
    return rankByPrefixAndFrecency(items, ctx.currentToken, (m) => m.id, (m) => `${m.id} ${m.desc}`).map((m) => ({
      value: m.id,
      label: `${m.id}${m.id === current ? CURRENT_MARK : ''}`,
      description: m.desc,
      intent: 'runOnEnter',
    }));
  });

  // 6. /screen [alt|main]
  completers.set('screen', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    const items = [
      { id: 'alt', desc: 'Fullscreen alternate screen with scroll & click' },
      { id: 'main', desc: 'Main screen with native terminal scrollback' },
    ];
    return rankByPrefixAndFrecency(items, ctx.currentToken, (m) => m.id, (m) => `${m.id} ${m.desc}`).map((m) => ({
      value: m.id,
      label: `${m.id}${m.id === snap.screenMode ? CURRENT_MARK : ''}`,
      description: m.desc,
      intent: 'runOnEnter',
    }));
  });

  // 7. /agent [name]
  completers.set('agent', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    return rankByPrefixAndFrecency(
      snap.availableAgentProfiles,
      ctx.currentToken,
      (p) => p.name,
      (p) => `${p.name} ${p.description ?? ''}`,
    ).map((p) => ({
      value: p.name,
      label: `${p.name}${p.name === snap.currentAgentProfile ? CURRENT_MARK : ''}`,
      description: p.description ?? 'Agent profile',
      intent: 'runOnEnter',
    }));
  });

  // 8. /agent-transcript [agent-id]
  completers.set('agent-transcript', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    return rankByPrefixAndFrecency(
      snap.sessionAgents,
      ctx.currentToken,
      (a) => a.id,
      (a) => `${a.id} ${a.label} ${a.status ?? ''}`,
    ).map((a) => ({
      value: a.id,
      label: `${a.id}${a.id === snap.focusedAgentId ? CURRENT_MARK : ''}`,
      description: a.status ? `${a.label} · ${a.status}` : a.label,
      intent: 'runOnEnter',
    }));
  });

  // 9. /login [provider] & 10. /logout [provider]
  completers.set('login', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    snap.requestLazyRefresh('providers');
    const executorItems = buildLoginArgumentCompletions(
      ctx.currentToken,
      snap.executorCatalog ?? [],
      snap.pendingAntigravityLogin === true,
    ).map((item) => ({ ...item, intent: 'insert' as const }));
    const seen = new Set(executorItems.map((item) => item.value));
    const eligible = snap.providers.filter((p) => p.authSupported !== false && !seen.has(p.id));
    const providerItems = rankByPrefixAndFrecency(
      eligible,
      ctx.currentToken,
      (p) => p.id,
      (p) => `${p.id} ${p.description ?? ''}`,
    ).map((p) => ({
      value: p.id,
      label: p.id,
      description: p.authenticated ? 'authenticated' : (p.description ?? 'Authenticate provider'),
      intent: 'insert' as const,
    }));
    return [...executorItems, ...providerItems];
  });

  completers.set('logout', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    snap.requestLazyRefresh('providers');
    const authed = snap.providers.filter((p) => p.authenticated !== false);
    return rankByPrefixAndFrecency(
      authed,
      ctx.currentToken,
      (p) => p.id,
      (p) => `${p.id} ${p.description ?? ''}`,
    ).map((p) => ({
      value: p.id,
      label: p.id,
      description: 'Log out of provider',
      intent: 'insert',
    }));
  });

  // 11. /copy [N]
  completers.set('copy', (ctx) => {
    if (ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    const candidates = snap.copyCandidates.slice(0, 10);
    return rankByPrefixAndFrecency(
      candidates,
      ctx.currentToken,
      (c) => String(c.index),
      (c) => `${String(c.index)} ${c.preview}`,
    ).map((c) => ({
      value: String(c.index),
      label: String(c.index),
      description: c.preview,
      intent: 'runOnEnter',
    }));
  });

  // 12. /plugins [marketplace|install|enable|disable|remove|reload] ...
  completers.set('plugins', (ctx) => {
    const snap = getSnapshot();
    if (ctx.tokenIndex === 0) {
      const stages = [
        { id: 'marketplace', desc: 'Browse configured plugin marketplace', intent: 'continue' as const },
        { id: 'install', desc: 'Install a plugin from path, URL, or catalog', intent: 'continue' as const },
        { id: 'enable', desc: 'Enable an installed plugin', intent: 'continue' as const },
        { id: 'disable', desc: 'Disable an installed plugin', intent: 'continue' as const },
        { id: 'remove', desc: 'Remove an installed plugin', intent: 'continue' as const },
        { id: 'reload', desc: 'Reload all plugins', intent: 'runOnEnter' as const },
      ];
      return rankByPrefixAndFrecency(stages, ctx.currentToken, (s) => s.id, (s) => `${s.id} ${s.desc}`).map((s) => ({
        value: s.intent === 'continue' ? `${s.id} ` : s.id,
        label: s.id,
        description: s.desc,
        intent: s.intent,
      }));
    }
    const sub = ctx.priorTokens[0]?.toLowerCase();
    if (sub === 'enable' || sub === 'disable' || sub === 'remove') {
      if (ctx.tokenIndex > 1) return null;
      snap.requestLazyRefresh('plugins');
      const candidates = snap.plugins.filter((p) =>
        sub === 'enable' ? !p.enabled : sub === 'disable' ? p.enabled : true,
      );
      return rankByPrefixAndFrecency(
        candidates,
        ctx.currentToken,
        (p) => p.id,
        (p) => `${p.id} ${p.name ?? ''}`,
      ).map((p) => ({
        value: p.id,
        label: p.id,
        description: p.name ? `${p.name} · ${p.enabled ? 'enabled' : 'disabled'}` : (p.enabled ? 'enabled' : 'disabled'),
        intent: 'insert',
      }));
    }
    if (sub === 'install') {
      const prev = ctx.priorTokens[ctx.priorTokens.length - 1];
      if (prev === '--sha256') {
        // Expecting hex digest, not a plugin ID or flag.
        return null;
      }
      const flags = [
        { id: '--trust', desc: 'Consent to full account permissions during install', value: '--trust ', intent: 'continue' as const },
        { id: '--sha256', desc: 'Pin expected archive SHA-256 digest', value: '--sha256 ', intent: 'continue' as const },
      ].filter((f) => !ctx.priorTokens.includes(f.id));
      if (ctx.currentToken.startsWith('-') || (ctx.currentToken.length === 0 && ctx.trigger === 'tab')) {
        const flagItems = rankByPrefixAndFrecency(flags, ctx.currentToken, (f) => f.id, (f) => `${f.id} ${f.desc}`).map((f) => ({
          value: f.value,
          label: f.id,
          description: f.desc,
          intent: f.intent,
        }));
        const pathItems = ctx.currentToken.startsWith('-') ? [] : listPathCompletions(snap.workDir, ctx.currentToken);
        return [...flagItems, ...pathItems];
      }
      return listPathCompletions(snap.workDir, ctx.currentToken);
    }
    return null;
  });
  hints.set('plugins', (ctx) => {
    const sub = ctx.priorTokens[0]?.toLowerCase();
    if (sub === 'install') {
      if (ctx.priorTokens[ctx.priorTokens.length - 1] === '--sha256') return '<hex>';
      return '[--trust] [--sha256 <hex>] <source>';
    }
    if (sub === 'marketplace') return '[source]';
    return undefined;
  });

  // 13. /tasks [stop|output|<task-id>]
  completers.set('tasks', (ctx) => {
    const snap = getSnapshot();
    snap.requestLazyRefresh('tasks');
    if (ctx.tokenIndex === 0) {
      const subItems: AutocompleteItem[] = [
        { value: 'output ', label: 'output', description: 'View task output', intent: 'continue' },
        { value: 'stop ', label: 'stop', description: 'Stop a running background task', intent: 'continue' },
        ...snap.tasks.map((t) => ({
          value: t.id,
          label: t.id,
          description: `${t.status}${t.description ? ` · ${t.description}` : ''}`,
          intent: 'runOnEnter' as const,
        })),
      ];
      return rankByPrefixAndFrecency(
        subItems,
        ctx.currentToken,
        (i) => i.label,
        (i) => `${i.label} ${i.description ?? ''}`,
      );
    }
    const sub = ctx.priorTokens[0]?.toLowerCase();
    if ((sub === 'stop' || sub === 'output') && ctx.tokenIndex === 1) {
      const pool = sub === 'stop'
        ? snap.tasks.filter((t) => t.status === 'running' || t.status === 'pending' || t.status === 'starting')
        : snap.tasks;
      return rankByPrefixAndFrecency(
        pool,
        ctx.currentToken,
        (t) => t.id,
        (t) => `${t.id} ${t.status} ${t.description ?? ''}`,
      ).map((t) => ({
        value: t.id,
        label: t.id,
        description: `${t.status}${t.description ? ` · ${t.description}` : ''}`,
        intent: sub === 'stop' ? 'insert' : 'runOnEnter',
      }));
    }
    return null;
  });

  // 14. /persona [list|switch <id>]
  completers.set('persona', (ctx) => {
    const snap = getSnapshot();
    if (ctx.tokenIndex === 0) {
      const subs = [
        { id: 'list', desc: 'List available personas', value: 'list', intent: 'runOnEnter' as const },
        { id: 'switch', desc: 'Start a new session with a persona', value: 'switch ', intent: 'continue' as const },
      ];
      return rankByPrefixAndFrecency(subs, ctx.currentToken, (s) => s.id, (s) => `${s.id} ${s.desc}`).map((s) => ({
        value: s.value,
        label: s.id,
        description: s.desc,
        intent: s.intent,
      }));
    }
    if (ctx.priorTokens[0]?.toLowerCase() === 'switch' && ctx.tokenIndex === 1) {
      snap.requestLazyRefresh('personas');
      return rankByPrefixAndFrecency(
        snap.personas,
        ctx.currentToken,
        (p) => p.id,
        (p) => `${p.id} ${p.name}`,
      ).map((p) => ({
        value: p.id,
        label: p.id,
        description: p.name,
        intent: 'runOnEnter',
      }));
    }
    return null;
  });

  // 15. /provider [add|remove|refresh]
  completers.set('provider', (ctx) => {
    const snap = getSnapshot();
    if (ctx.tokenIndex === 0) {
      const subs = [
        { id: 'refresh', desc: 'Refresh provider catalog', value: 'refresh', intent: 'runOnEnter' as const },
        { id: 'remove', desc: 'Remove a configured provider', value: 'remove ', intent: 'continue' as const },
        { id: 'add', desc: 'Add a provider', value: 'add ', intent: 'continue' as const },
      ];
      return rankByPrefixAndFrecency(subs, ctx.currentToken, (s) => s.id, (s) => `${s.id} ${s.desc}`).map((s) => ({
        value: s.value,
        label: s.id,
        description: s.desc,
        intent: s.intent,
      }));
    }
    if (ctx.priorTokens[0]?.toLowerCase() === 'remove' && ctx.tokenIndex === 1) {
      snap.requestLazyRefresh('providers');
      return rankByPrefixAndFrecency(
        snap.providers,
        ctx.currentToken,
        (p) => p.id,
        (p) => `${p.id} ${p.description ?? ''}`,
      ).map((p) => ({
        value: p.id,
        label: p.id,
        description: p.description ?? 'Configured provider',
        intent: 'insert',
      }));
    }
    return null;
  });
  hints.set('provider', (ctx) => {
    if (ctx.priorTokens[0]?.toLowerCase() === 'add') {
      return ctx.tokenIndex === 1 ? '<id> <json>' : '<json>';
    }
    return undefined;
  });

  // 16. /settings [json|<domain>] [json]
  completers.set('settings', (ctx) => {
    const snap = getSnapshot();
    if (ctx.tokenIndex === 0) {
      snap.requestLazyRefresh('configDomains');
      const items = [
        { id: 'json', desc: 'Show full daemon config JSON' },
        ...snap.configDomains.map((d) => ({ id: d, desc: `Inspect or update ${d} config domain` })),
      ];
      return rankByPrefixAndFrecency(items, ctx.currentToken, (i) => i.id, (i) => `${i.id} ${i.desc}`).map((i) => ({
        value: i.id,
        label: i.id,
        description: i.desc,
        intent: 'insert',
      }));
    }
    return null;
  });
  hints.set('settings', (ctx) => (ctx.tokenIndex >= 1 ? '<json>' : undefined));

  // 17. /web [temporary|persistent|status|off|link|revoke] ...
  completers.set('web', (ctx) => {
    const snap = getSnapshot();
    if (ctx.tokenIndex === 0) {
      const actions = [
        { id: 'temporary', desc: 'Start a temporary browser session', value: 'temporary ', intent: 'continue' as const },
        { id: 'persistent', desc: 'Start a persistent browser server', value: 'persistent ', intent: 'continue' as const },
        { id: 'status', desc: 'Show browser access status', value: 'status', intent: 'runOnEnter' as const },
        { id: 'link', desc: 'Print browser access link', value: 'link', intent: 'runOnEnter' as const },
        { id: 'off', desc: 'Stop browser access', value: 'off', intent: 'insert' as const },
        { id: 'revoke', desc: 'Revoke a browser session ID', value: 'revoke ', intent: 'continue' as const },
      ];
      return rankByPrefixAndFrecency(actions, ctx.currentToken, (a) => a.id, (a) => `${a.id} ${a.desc}`).map((a) => ({
        value: a.value,
        label: a.id,
        description: a.desc,
        intent: a.intent,
      }));
    }
    const action = ctx.priorTokens[0]?.toLowerCase();
    if (action === 'revoke' && ctx.tokenIndex === 1) {
      snap.requestLazyRefresh('webSessions');
      return rankByPrefixAndFrecency(snap.webSessionIds, ctx.currentToken, (id) => id, (id) => id).map((id) => ({
        value: id,
        label: id,
        description: 'Active browser session',
        intent: 'insert',
      }));
    }
    if (action === 'temporary' || action === 'persistent') {
      const prev = ctx.priorTokens[ctx.priorTokens.length - 1];
      if (prev === '--host' || prev === '--port' || prev === '--public-url') {
        return null;
      }
      const flags = [
        { id: '--host', desc: 'Bind host address', value: '--host ', intent: 'continue' as const },
        { id: '--port', desc: 'Bind port number', value: '--port ', intent: 'continue' as const },
        { id: '--public-url', desc: 'Public reverse-proxy URL', value: '--public-url ', intent: 'continue' as const },
        { id: '--insecure-no-tls', desc: 'Allow plain HTTP', value: '--insecure-no-tls', intent: 'insert' as const },
        { id: '--no-open', desc: 'Do not open browser automatically', value: '--no-open', intent: 'insert' as const },
      ].filter((f) => !ctx.priorTokens.includes(f.id));
      if (ctx.currentToken.startsWith('-') || ctx.trigger === 'tab') {
        return rankByPrefixAndFrecency(flags, ctx.currentToken, (f) => f.id, (f) => `${f.id} ${f.desc}`).map((f) => ({
          value: f.value,
          label: f.id,
          description: f.desc,
          intent: f.intent,
        }));
      }
    }
    return null;
  });
  hints.set('web', (ctx) => {
    const action = ctx.priorTokens[0]?.toLowerCase();
    const prev = ctx.priorTokens[ctx.priorTokens.length - 1];
    if (prev === '--port') return '<port>';
    if (prev === '--host') return '<host>';
    if (prev === '--public-url') return '<url>';
    if (action === 'temporary' || action === 'persistent') {
      return '[--host <host>] [--port <port>] [--no-open]';
    }
    if (action === 'revoke') return '[session-id]';
    return undefined;
  });

  // 18. /attach <path> & 19. /export-view [path]
  completers.set('attach', (ctx) => {
    const snap = getSnapshot();
    return listPathCompletions(snap.workDir, ctx.rawArgs, ctx.argsStartCol, ctx.replaceEndCol);
  });
  completers.set('export-view', (ctx) => {
    const snap = getSnapshot();
    const pathItems = listPathCompletions(
      snap.workDir,
      ctx.rawArgs,
      ctx.argsStartCol,
      ctx.replaceEndCol,
    );
    if (ctx.rawArgs.trim().length === 0 && snap.sessionId) {
      const def = `kimi-session-${snap.sessionId.slice(0, 8)}.md`;
      return [
        {
          value: def,
          label: def,
          description: 'Default export filename',
          intent: 'insert',
          replaceStartCol: ctx.argsStartCol,
          replaceEndCol: ctx.replaceEndCol,
        },
        ...pathItems,
      ];
    }
    return pathItems;
  });

  // 20. /goal — freeform-guarded: ONLY pop suggestions on explicit Tab so typing
  // `/goal pa` or `/goal pause rollout` NEVER hijacks Enter!
  completers.set('goal', (ctx) => {
    if (ctx.trigger !== 'tab' || ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    const all = [
      { id: 'status', desc: 'Show current goal status', available: true, value: 'status', intent: 'insert' as const },
      { id: 'pause', desc: 'Pause the active goal', available: snap.goalStatus === 'running', value: 'pause', intent: 'insert' as const },
      { id: 'resume', desc: 'Resume the paused goal', available: snap.goalStatus === 'paused', value: 'resume', intent: 'insert' as const },
      { id: 'cancel', desc: 'Cancel the active goal', available: snap.goalStatus === 'running' || snap.goalStatus === 'paused', value: 'cancel', intent: 'insert' as const },
      { id: 'replace', desc: 'Replace the active goal objective', available: snap.goalStatus === 'running' || snap.goalStatus === 'paused', value: 'replace ', intent: 'continue' as const },
    ].filter((item) => item.available);
    return rankByPrefixAndFrecency(all, ctx.currentToken, (i) => i.id, (i) => `${i.id} ${i.desc}`).map((i) => ({
      value: i.value,
      label: i.id,
      description: i.desc,
      intent: i.intent,
    }));
  });
  hints.set('goal', (ctx) =>
    ctx.priorTokens[0]?.toLowerCase() === 'replace' ? '<new objective>' : undefined,
  );

  // 21. /branch — freeform-guarded: ONLY suggest `main` on explicit Tab when on a branch/child!
  completers.set('branch', (ctx) => {
    if (ctx.trigger !== 'tab' || ctx.tokenIndex > 0) return null;
    const snap = getSnapshot();
    if (snap.focusedAgentId === 'main') return null;
    if ('main'.startsWith(ctx.currentToken.toLowerCase())) {
      return [{ value: 'main', label: 'main', description: 'Return to main conversation', intent: 'insert' }];
    }
    return null;
  });

  // 22-26. Freeform hints (+ explicit Tab editor presets)
  completers.set('editor', (ctx) => {
    if (ctx.trigger !== 'tab' || ctx.tokenIndex > 0) return null;
    const presets = [
      { id: 'code --wait', desc: 'VS Code' },
      { id: 'cursor --wait', desc: 'Cursor' },
      { id: 'nvim', desc: 'Neovim' },
      { id: 'vim', desc: 'Vim' },
      { id: 'nano', desc: 'Nano' },
    ];
    return rankByPrefixAndFrecency(presets, ctx.currentToken, (p) => p.id, (p) => `${p.id} ${p.desc}`).map((p) => ({
      value: p.id,
      label: p.id,
      description: p.desc,
      intent: 'insert',
    }));
  });
  hints.set('compact', () => '[optional focus instruction]');
  hints.set('title', () => '[new session title]');
  hints.set('fork', () => '[optional fork title]');
  hints.set('merge', () => '[optional merge summary]');
  hints.set('queue', () => '<prompt>');
  hints.set('btw', () => '<question>');

  return { argumentCompleters: completers, argumentHintProviders: hints };
}
