/**
 * CLI-owned data path helpers.
 *
 * These paths are for local app data such as logs and input history. Config
 * files are owned by Core/SDK and intentionally do not live behind this module.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveKikiHome } from '@kiki/oauth';

import {
  KIKI_BANNER_DIR_NAME,
  KIKI_BANNER_STATE_FILE_NAME,
  KIKI_BIN_DIR_NAME,
  KIKI_CACHE_DIR_NAME,
  KIKI_INPUT_HISTORY_DIR_NAME,
  KIKI_LOG_DIR_NAME,
  KIKI_PLUGIN_UPDATE_NOTICE_STATE_FILE_NAME,
  KIKI_UPDATE_DIR_NAME,
} from '#/constant/app';

/** Returns the same Kiki home used by the daemon and provider credential store. */
export function getDataDir(): string {
  return resolveKikiHome();
}

/**
 * Return the diagnostic log directory: `<dataDir>/logs/`.
 */
export function getLogDir(): string {
  return join(getDataDir(), KIKI_LOG_DIR_NAME);
}

/**
 * Return the CLI cache directory: `<dataDir>/cache/`.
 */
export function getCacheDir(): string {
  return join(getDataDir(), KIKI_CACHE_DIR_NAME);
}

/**
 * Return the managed tools directory: `<dataDir>/bin/`.
 */
export function getBinDir(): string {
  return join(getDataDir(), KIKI_BIN_DIR_NAME);
}

/**
 * Return the plugin update notice state file: `<dataDir>/updates/plugin-notices.json`.
 */
export function getPluginUpdateNoticeStateFile(): string {
  return join(
    getDataDir(),
    KIKI_UPDATE_DIR_NAME,
    KIKI_PLUGIN_UPDATE_NOTICE_STATE_FILE_NAME,
  );
}

/**
 * Return the banner display state file: `<dataDir>/cache/banner/state.json`.
 */
export function getBannerStateFile(): string {
  return join(getCacheDir(), KIKI_BANNER_DIR_NAME, KIKI_BANNER_STATE_FILE_NAME);
}

/**
 * Return the user input history file for a given working directory.
 * Layout: `<share_dir>/user-history/<md5(cwd)>.jsonl`.
 */
export function getInputHistoryFile(workDir: string): string {
  const hash = createHash('md5').update(workDir, 'utf-8').digest('hex');
  return join(getDataDir(), KIKI_INPUT_HISTORY_DIR_NAME, `${hash}.jsonl`);
}
