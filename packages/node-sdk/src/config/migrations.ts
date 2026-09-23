/**
 * One-shot config migrations. Each migration runs at most once per kimi home:
 * a marker in `<home>/migrations-effort.json` records completion (ISO
 * timestamp), so a value the user re-sets by hand afterwards is never
 * migrated again. All helpers are best-effort and never throw — a migration
 * must never block startup.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { join } from 'pathe';
import { stringify as stringifyToml } from 'smol-toml';

import { credentialsPathFor, splitConfigCredentials } from './credentials';
import { ensureKikiHome } from './path';
import { configToTomlData, readConfigFileForUpdate } from './toml';
import { validateConfig } from './schema';

const MIGRATIONS_FILE = 'migrations-effort.json';
const THINKING_EFFORT_MAX_TO_HIGH = 'thinking-effort-max-to-high';

function readMigrationMarkers(homeDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(homeDir, MIGRATIONS_FILE), 'utf-8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Missing or corrupt marker file — treated as "no migrations done".
  }
  return {};
}

function writeMigrationMarker(homeDir: string, key: string): void {
  try {
    ensureKikiHome(homeDir);
    const markers = readMigrationMarkers(homeDir);
    markers[key] = new Date().toISOString();
    writeFileSync(join(homeDir, MIGRATIONS_FILE), `${JSON.stringify(markers, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    // A lost marker only means the check runs once more — harmless.
  }
}

/**
 * Persisted `thinking.effort = "max"` dates from when the UI recorded any pick
 * unconditionally. `max` is session-only now, so rewrite it to `"high"` once.
 * Skipped when the marker exists; a config that cannot be parsed is left
 * untouched AND unmarked so the next start retries. All other values — and a
 * `max` the user writes by hand after the migration — are honored as-is.
 *
 * The rewrite uses the same secret split as `writeConfigFile`: provider
 * credentials go to the companion `credentials.toml`, never back into
 * `config.toml`. Credentials are written first, and only when the merged
 * document actually carries a secret, so an empty scaffold is left untouched.
 */
export function migrateThinkingEffortMaxToHigh(configPath: string, homeDir: string): void {
  try {
    if (readMigrationMarkers(homeDir)[THINKING_EFFORT_MAX_TO_HIGH] !== undefined) return;
    if (!existsSync(configPath)) {
      writeMigrationMarker(homeDir, THINKING_EFFORT_MAX_TO_HIGH);
      return;
    }
    let config;
    try {
      config = readConfigFileForUpdate(configPath);
    } catch {
      return; // Unreadable config: no marker, retry on the next start.
    }
    if (config.thinking?.effort === 'max') {
      const validated = validateConfig({
        ...config,
        thinking: { ...config.thinking, effort: 'high' },
      });
      const separated = splitConfigCredentials(configToTomlData(validated));
      if (Object.keys(separated.credentials).length > 0) {
        writeFileReplacing(credentialsPathFor(configPath), `${stringifyToml(separated.credentials)}\n`);
      }
      writeFileReplacing(configPath, `${stringifyToml(separated.config)}\n`);
    }
    writeMigrationMarker(homeDir, THINKING_EFFORT_MAX_TO_HIGH);
  } catch {
    // Best-effort: never block startup on a migration.
  }
}

/** Owner-only atomic replace, matching the migration's original `0600` write. */
function writeFileReplacing(filePath: string, text: string): void {
  const tmp = `${filePath}.migrate-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, filePath);
}
