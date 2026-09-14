import {
  parsePromptOverrideDocument,
  validatePromptOverridePath,
  type PromptOverrideDocument,
} from '@kiki/agent-profiles/promptOverrides';
import { parse as parseToml } from 'smol-toml';
import { isAbsolute, join, normalize, relative } from 'pathe';

import { Error2 } from '#/_base/errors/errors';
import { CoreErrors } from '#/_base/errors/codes';
import type { PathClass } from '#/os/interface/hostEnvironment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

const MAX_PROMPT_OVERRIDE_FILE_BYTES = 1024 * 1024;

export interface LoadedPromptOverrideFile {
  readonly ref: string;
  readonly document: PromptOverrideDocument;
  readonly lines: Readonly<Record<string, number>>;
}

export async function readPromptOverrideFile(
  fs: IHostFileSystem,
  homeDir: string,
  ref: string,
  pathClass: PathClass,
): Promise<LoadedPromptOverrideFile> {
  let relativePath: string;
  try {
    relativePath = validatePromptOverridePath(ref);
  } catch (error) {
    throw invalidPromptOverrideFile('Prompt override file path is invalid', ref, error);
  }
  const lexical = normalize(join(homeDir, relativePath));
  let realHome: string;
  let realFile: string;
  try {
    [realHome, realFile] = await Promise.all([
      fs.realpath(homeDir),
      fs.realpath(lexical),
    ]);
  } catch (error) {
    throw invalidPromptOverrideFile('Prompt override file could not be resolved', ref, error);
  }
  if (!isWithinHome(realFile, realHome, pathClass)) {
    throw invalidPromptOverrideFile('Prompt override file escapes the Kiki home directory', ref);
  }
  let stat;
  try {
    stat = await fs.stat(realFile);
  } catch (error) {
    throw invalidPromptOverrideFile('Prompt override file could not be inspected', ref, error);
  }
  if (!stat.isFile) {
    throw invalidPromptOverrideFile('Prompt override path does not reference a file', ref);
  }
  if (stat.size > MAX_PROMPT_OVERRIDE_FILE_BYTES) {
    throw invalidPromptOverrideFile('Prompt override file exceeds the size limit', ref);
  }
  let text: string;
  try {
    text = await fs.readText(realFile);
  } catch (error) {
    throw invalidPromptOverrideFile('Prompt override file could not be read', ref, error);
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (error) {
    throw invalidPromptOverrideFile('Prompt override TOML is invalid', ref, error);
  }
  try {
    const result = parsePromptOverrideDocument(parsed, { path: ref, text });
    return { ref, document: result.document, lines: result.lines };
  } catch (error) {
    throw invalidPromptOverrideFile('Prompt override document is invalid', ref, error);
  }
}

function isWithinHome(candidate: string, home: string, pathClass: PathClass): boolean {
  const normalizedCandidate = normalize(candidate);
  const normalizedHome = normalize(home);
  const comparableCandidate = pathClass === 'win32' ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const comparableHome = pathClass === 'win32' ? normalizedHome.toLowerCase() : normalizedHome;
  const rel = relative(comparableHome, comparableCandidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
}

function invalidPromptOverrideFile(message: string, ref: string, cause?: unknown): Error2 {
  return new Error2(CoreErrors.codes.VALIDATION_FAILED, message, {
    cause,
    details: { ref },
    name: 'PromptOverrideFileError',
  });
}
