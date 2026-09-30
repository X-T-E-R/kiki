// @vitest-environment jsdom

/**
 * Space-scoped storage contract (isolation design §6.4): the wrapper's key
 * names, the desktop boot hand-off, the call sites that must route through it,
 * and a source scan that fails when a key joins the shared namespace without
 * being classified in the inventory.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadPinnedLanes, savePinnedLanes } from '../components/settings/nbSearch/types';
import { readTimelineView, writeTimelineView } from '../components/message/messageViewMode';
import { writeBackgroundPrefs } from './skins/background';
import { readSkinPrefs, writeSkinPrefs } from './skins/store';
import {
  ACTIVE_SPACE_BOOT_GLOBAL,
  EXCLUDED_STORAGE_KEYS,
  GLOBAL_STORAGE_KEYS,
  MAIN_SPACE_HOME_ID,
  SPACE_SCOPED_KEY_PREFIXES,
  SPACE_SCOPED_STORAGE_KEYS,
  activeSpace,
  configureSpaceStorage,
  initializeSpaceStorage,
  parseActiveSpacePayload,
  spaceStorageKey,
  type SpaceBootHost,
} from './spaceStorage';
import { USAGE_FILTER_DEFAULTS, readStoredUsageFilters, writeStoredUsageFilters } from './usageV2';

// Matches the repo's other fs-driven GUI tests: vitest gives `import.meta.url`
// a file URL here, while `new URL(..., import.meta.url)` does not.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function clearInjectedSpace(): void {
  delete (window as unknown as Record<string, unknown>)[ACTIVE_SPACE_BOOT_GLOBAL];
}

afterEach(() => {
  configureSpaceStorage(null);
  clearInjectedSpace();
  localStorage.clear();
});

describe('active-space payload', () => {
  it('accepts an object or its JSON text', () => {
    expect(parseActiveSpacePayload({ homeId: 'acme', name: 'ACME', color: '#f00' })).toEqual({
      homeId: 'acme',
      name: 'ACME',
      color: '#f00',
      isPrimary: undefined,
    });
    expect(parseActiveSpacePayload('{"homeId":"acme"}')).toEqual({
      homeId: 'acme',
      name: undefined,
      color: undefined,
      isPrimary: undefined,
    });
  });

  it('reads the main space from its homeId or an explicit flag', () => {
    expect(parseActiveSpacePayload({ homeId: MAIN_SPACE_HOME_ID })).toMatchObject({ isPrimary: true });
    expect(parseActiveSpacePayload({ homeId: 'acme', isPrimary: true })).toMatchObject({ isPrimary: true });
  });

  it('degrades unknown payloads to the main space instead of inventing a namespace', () => {
    for (const raw of [null, undefined, 42, [], '', 'not json', {}, { homeId: '' }, { homeId: 7 }]) {
      expect(parseActiveSpacePayload(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

describe('space storage boot', () => {
  function tauriHost(payload: unknown): SpaceBootHost & { activeSpace: () => Promise<unknown> } {
    return { kind: 'tauri', activeSpace: () => Promise.resolve(payload) };
  }

  it('namespaces a subspace the desktop reports', async () => {
    await initializeSpaceStorage(tauriHost({ homeId: 'acme', name: 'ACME' }));
    expect(activeSpace()).toEqual({ homeId: 'acme', name: 'ACME', color: undefined, isPrimary: undefined });
    expect(spaceStorageKey('kiki.skin')).toBe('kiki.space.acme.kiki.skin');
  });

  it('keeps the original keys for the main space', async () => {
    await initializeSpaceStorage(tauriHost({ homeId: MAIN_SPACE_HOME_ID, name: 'Kiki' }));
    expect(activeSpace()).toBeNull();
    expect(spaceStorageKey('kiki.skin')).toBe('kiki.skin');
  });

  it('falls back to the main space when the desktop build has no space command yet', async () => {
    const failing: SpaceBootHost = { kind: 'tauri', activeSpace: () => Promise.reject(new Error('unknown command')) };
    await expect(initializeSpaceStorage(failing)).resolves.toBeNull();
    expect(spaceStorageKey('kiki.skin')).toBe('kiki.skin');
  });

  it('never namespaces a browser or VS Code host', async () => {
    await expect(initializeSpaceStorage({ kind: 'browser' })).resolves.toBeNull();
    await expect(initializeSpaceStorage({ kind: 'vscode' })).resolves.toBeNull();
    expect(spaceStorageKey('kiki.skin')).toBe('kiki.skin');
  });

  it('prefers a payload injected before the bundle ran over the command', async () => {
    (window as unknown as Record<string, unknown>)[ACTIVE_SPACE_BOOT_GLOBAL] = { homeId: 'injected' };
    const command = vi.fn(() => Promise.resolve({ homeId: 'from-command' }));
    const space = await initializeSpaceStorage({ kind: 'tauri', activeSpace: command });
    expect(space?.homeId).toBe('injected');
    expect(command).not.toHaveBeenCalled();
  });
});

describe('call sites route through the wrapper', () => {
  it('writes skin prefs, background, usage filters and pinned lanes into the namespace', () => {
    configureSpaceStorage({ homeId: 'acme' });

    writeSkinPrefs({ tweaks: { accent: '#0b6e87' } });
    expect(readSkinPrefs().tweaks.accent).toBe('#0b6e87');
    expect(localStorage.getItem('kiki.space.acme.kiki.skin')).toContain('#0b6e87');
    expect(localStorage.getItem('kiki.skin')).toBeNull();

    writeBackgroundPrefs({ light: null, dark: null, linked: true, assist: false });
    expect(localStorage.getItem('kiki.space.acme.kiki.background')).toContain('"assist":false');
    expect(localStorage.getItem('kiki.background')).toBeNull();

    const filters = { ...USAGE_FILTER_DEFAULTS, range: 'this_month' as const };
    writeStoredUsageFilters(filters);
    expect(readStoredUsageFilters()).toEqual(filters);
    expect(localStorage.getItem('kiki.space.acme.kiki.usage.filters.v2')).not.toBeNull();
    expect(localStorage.getItem('kiki.usage.filters.v2')).toBeNull();

    savePinnedLanes(['lane-a']);
    expect(loadPinnedLanes()).toEqual(['lane-a']);
    expect(localStorage.getItem('kiki.space.acme.kiki.nb_search.pinned_lanes')).toBe('["lane-a"]');
    expect(localStorage.getItem('kiki.nb_search.pinned_lanes')).toBeNull();
  });

  it('isolates timeline choices for the same session id across spaces', () => {
    writeTimelineView('shared-session-id', 'message');
    configureSpaceStorage({ homeId: 'acme' });
    expect(readTimelineView('shared-session-id', { delivery: 'reply' })).toBe('process');
    writeTimelineView('shared-session-id', 'process');
    expect(localStorage.getItem('kiki.space.acme.kiki.timelineView')).toContain('process');
    configureSpaceStorage(null);
    expect(readTimelineView('shared-session-id', { delivery: 'reply' })).toBe('message');
  });

  it('reads the same key the main space wrote before the switch', () => {
    writeSkinPrefs({ tweaks: { accent: '#123456' } });
    expect(localStorage.getItem('kiki.skin')).toContain('#123456');
    configureSpaceStorage({ homeId: 'acme' });
    expect(readSkinPrefs().tweaks.accent).toBeUndefined();
    expect(localStorage.getItem('kiki.space.acme.kiki.skin')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Source scan: the §6.4 inventory must cover what the sources actually do.
// ---------------------------------------------------------------------------

const SOURCE_ROOTS = ['apps/kiki-gui/src', 'packages/session-core/src'] as const;

/** Modules that own the storage mechanism itself. */
const WRAPPER_FILES = new Set<string>([
  'apps/kiki-gui/src/lib/spaceStorage.ts',
  'packages/session-core/src/storage/spaceStorage.ts',
  'packages/session-core/src/storage/index.ts',
]);

/**
 * Modules allowed to call `localStorage` directly, because every key they touch
 * is application-level (or deliberately outside the namespace). A module that
 * is not listed here must go through `spaceStorage` — that is what keeps a
 * newly added key from silently joining the shared namespace.
 */
const RAW_STORAGE_ALLOWLIST = new Set<string>([
  ...WRAPPER_FILES,
  // Mixed: global `kiki.settings` / `kiki.desktopPrefs` + space-scoped keys
  // through the wrapper.
  'packages/session-core/src/settings/settings.ts',
  // Global: `kiki.layout`.
  'packages/session-core/src/settings/layoutPrefs.ts',
  // Global: `kiki.terminalPanel.v1`.
  'packages/session-core/src/settings/terminalPrefs.ts',
  // Global: `kiki.locale`.
  'apps/kiki-gui/src/i18n/index.tsx',
  'apps/kiki-gui/src/lib/timelineLocate.ts',
  // Global: `kiki.previewPanelWidth`.
  'apps/kiki-gui/src/components/mediaPreview.tsx',
  // Global: `kiki.railMode`.
  'apps/kiki-gui/src/components/rail-variants/shell.tsx',
  // Excluded: `kiki.connection` (desktop connections never persist).
  'apps/kiki-gui/src/state/connectionConfig.ts',
]);

const KEY_LITERAL = /kiki\.[A-Za-z0-9_.-]*/g;

/** A `/` after one of these starts a regex literal, not a division. */
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

function lastSignificant(text: string): string | undefined {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') return ch;
  }
  return undefined;
}

/**
 * Drop comments before scanning: docblocks name keys and `localStorage` all the
 * time, and prose is not a call site. String and template contents are kept
 * verbatim, so a literal in code can never be hidden by this pass — the worst
 * case is a comment that survives and reads as a mention.
 */
function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 1;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    if (ch === '/') {
      const previous = lastSignificant(out);
      if (previous === undefined || REGEX_PRECEDERS.has(previous)) {
        // Regex literal: `'` and `"` inside it are characters, not quotes.
        out += ch;
        let inClass = false;
        for (i += 1; i < source.length; i += 1) {
          const char = source[i]!;
          if (char === '\n') break;
          out += char;
          if (char === '\\') {
            out += source[i + 1] ?? '';
            i += 1;
          } else if (char === '[') inClass = true;
          else if (char === ']') inClass = false;
          else if (char === '/' && !inClass) break;
        }
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
  }
  return out;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|integration|e2e)\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function repoPath(full: string): string {
  return relative(REPO_ROOT, full).replaceAll('\\', '/');
}

interface ScannedSource {
  readonly path: string;
  /** Raw text: used for the `localStorage.` access pattern, which prose never has. */
  readonly source: string;
  /** Comment-free text: used for key literals and the mechanism's own calls. */
  readonly code: string;
}

function scannedSources(): readonly ScannedSource[] {
  return SOURCE_ROOTS.flatMap((root) =>
    sourceFiles(join(REPO_ROOT, root)).map((full) => {
      const source = readFileSync(full, 'utf8');
      return { path: repoPath(full), source, code: stripComments(source) };
    }),
  );
}

/** True when the module reads or writes `localStorage`, code rather than prose. */
function usesRawLocalStorage(file: ScannedSource): boolean {
  const withoutAvailabilityChecks = file.code.replace(/\btypeof\s+localStorage\b(?!\s*[.\[])/g, '');
  return /\blocalStorage\b/.test(withoutAvailabilityChecks);
}

function quotedKeyLiterals(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(KEY_LITERAL)) {
    const before = code.slice(0, match.index).at(-1);
    if (before === "'" || before === '"' || before === '`') found.push(match[0]);
  }
  return found;
}

function isClassified(key: string): boolean {
  return (
    (SPACE_SCOPED_STORAGE_KEYS as readonly string[]).includes(key) ||
    (GLOBAL_STORAGE_KEYS as readonly string[]).includes(key) ||
    (EXCLUDED_STORAGE_KEYS as readonly string[]).includes(key) ||
    SPACE_SCOPED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function isSpaceScoped(key: string): boolean {
  return (
    (SPACE_SCOPED_STORAGE_KEYS as readonly string[]).includes(key) ||
    SPACE_SCOPED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

describe('storage source scan', () => {
  const sources = scannedSources();

  it.each([
    ["typeof localStorage !== 'undefined'", false],
    ["// localStorage.getItem('kiki.drafts')\nspaceStorage.getItem('kiki.drafts')", false],
    ["localStorage.getItem('kiki.drafts')", true],
    ["typeof localStorage.getItem === 'function'", true],
    ["typeof localStorage['getItem'] === 'function'", true],
    ['const storage = localStorage', true],
    ["window.localStorage.getItem('kiki.drafts')", true],
    ["typeof localStorage !== 'undefined' && localStorage.getItem('kiki.drafts')", true],
  ])('detects raw storage use in %s', (source, expected) => {
    expect(usesRawLocalStorage({ path: 'example.ts', source, code: stripComments(source) })).toBe(expected);
  });

  it('has sources to scan', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('touches localStorage only in the wrapper and the listed application-level owners', () => {
    const offenders = sources
      .filter(usesRawLocalStorage)
      .map((file) => file.path)
      .filter((path) => !RAW_STORAGE_ALLOWLIST.has(path));
    expect(
      offenders,
      'route space-scoped keys through spaceStorage (lib/spaceStorage.ts) or list the module here with its application-level keys',
    ).toEqual([]);
  });

  it('classifies every kiki.* key a storage-touching module mentions', () => {
    const unclassified = new Set<string>();
    for (const file of sources) {
      if (WRAPPER_FILES.has(file.path)) continue;
      if (!usesRawLocalStorage(file) && !/\bspaceStorage\b/.test(file.code)) continue;
      for (const key of quotedKeyLiterals(file.code)) {
        if (!isClassified(key)) unclassified.add(`${file.path}: ${key}`);
      }
    }
    expect([...unclassified]).toEqual([]);
  });

  it('routes every space-scoped key of a storage-touching module through spaceStorage', () => {
    const offenders = sources
      .filter((file) => !WRAPPER_FILES.has(file.path))
      .filter((file) => usesRawLocalStorage(file) || /\bspaceStorage\b/.test(file.code))
      .filter((file) => quotedKeyLiterals(file.code).some(isSpaceScoped))
      .filter((file) => !/\bspaceStorage\./.test(file.code))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('keeps every inventory entry present in the sources', () => {
    // Registry declarations in the wrapper itself do not count as usage: an
    // entry that no module actually uses is a stale entry.
    const used = sources.filter((file) => !WRAPPER_FILES.has(file.path));
    const allKeys = new Set(used.flatMap((file) => quotedKeyLiterals(file.code)));
    const allCode = used.map((file) => file.code).join('\n');
    const missing = [
      ...SPACE_SCOPED_STORAGE_KEYS,
      ...GLOBAL_STORAGE_KEYS,
      ...EXCLUDED_STORAGE_KEYS,
      ...SPACE_SCOPED_KEY_PREFIXES,
    ].filter((key) => !allKeys.has(key) && !allCode.includes(`${key}\${`));
    expect(missing).toEqual([]);
  });

  it('keeps at least one space-scoped owner using the wrapper', () => {
    const users = sources
      .filter((file) => /\bspaceStorage\./.test(file.code))
      .map((file) => file.path);
    expect(users).toEqual(
      expect.arrayContaining([
        'packages/session-core/src/composer/drafts.ts',
        'packages/session-core/src/settings/settings.ts',
        'apps/kiki-gui/src/lib/skins/store.ts',
      ]),
    );
  });
});
