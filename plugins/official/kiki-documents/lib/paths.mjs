import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export class DocumentsError extends Error {
  constructor(code, message, suggestion) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
  }
}
const within = (file, root) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const exists = (file) => lstat(file).catch((error) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
async function canonicalNew(file) {
  if (await exists(file)) throw new DocumentsError('OUTPUT_EXISTS', `Output already exists: ${file}`, 'Choose a new output directory; existing files are never merged or overwritten.');
  const parent = path.dirname(file);
  if (parent === file) throw new DocumentsError('PATH_INVALID', 'Output cannot be a filesystem root.', 'Choose a new output directory inside the workspace.');
  const present = await exists(parent);
  if (present) return path.join(await realpath(parent), path.basename(file));
  return path.join(await canonicalNew(parent), path.basename(file));
}
export async function admitPaths(file, outputDir, scope) {
  if (typeof scope?.workspaceRoot !== 'string' || !path.isAbsolute(scope.workspaceRoot)) {
    throw new DocumentsError('WORKSPACE_UNAVAILABLE', 'The plugin host did not provide a workspace root.', 'Use a session with a local workspace.');
  }
  for (const input of [file, outputDir]) {
    if (typeof input !== 'string' || !input.trim() || input.length > 4096 || input.includes('\0') || /^[A-Za-z]:[^\\/]/.test(input)) {
      throw new DocumentsError('PATH_INVALID', 'Expected an unambiguous local file/directory path.', 'Use workspace-relative paths or explicitly approved absolute paths.');
    }
  }
  const workspace = await realpath(scope.workspaceRoot);
  const source = await realpath(path.resolve(workspace, file)).catch((error) => {
    if (error.code === 'ENOENT') throw new DocumentsError('FILE_MISSING', 'Source file does not exist.', 'Provide an existing local document.');
    throw error;
  });
  const info = await lstat(source);
  if (!info.isFile()) throw new DocumentsError('FILE_INVALID', 'Source must be a regular file.', 'Select one document, not a directory.');
  const output = await canonicalNew(path.resolve(workspace, outputDir));
  const roots = [workspace];
  for (const raw of scope.approvedPaths ?? []) {
    if (typeof raw === 'string' && path.isAbsolute(raw)) roots.push(await realpath(raw));
  }
  for (const target of [source, output]) {
    if (!roots.some((root) => within(target, root))) throw new DocumentsError('PATH_OUTSIDE_WORKSPACE', `Path is outside the approved workspace: ${target}`, 'Approve the external path through Kiki or use a workspace path.');
  }
  return { source, output };
}
