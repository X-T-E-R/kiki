import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export class OfficeError extends Error {
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

export async function admitFile(input, operation, scope) {
  if (typeof scope?.workspaceRoot !== 'string' || !path.isAbsolute(scope.workspaceRoot)) {
    throw new OfficeError('WORKSPACE_UNAVAILABLE', 'The plugin host did not provide a workspace root.', 'Open an Office document in a session with a workspace.');
  }
  if (typeof input !== 'string' || !input.trim() || /^[A-Za-z]:[^\\/]/.test(input)) {
    throw new OfficeError('PATH_INVALID', 'File must be a nonempty, unambiguous path.', 'Use a workspace-relative path or an explicitly approved absolute path.');
  }
  const workspace = await realpath(scope.workspaceRoot);
  const candidate = path.resolve(workspace, input);
  if (!['.docx', '.xlsx', '.pptx'].includes(path.extname(candidate).toLowerCase())) {
    throw new OfficeError('FORMAT_UNSUPPORTED', 'Only docx, xlsx and pptx files are supported.', 'Choose a .docx, .xlsx or .pptx document.');
  }
  const existing = await stat(candidate).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (operation === 'create' && existing !== undefined) {
    throw new OfficeError('FILE_EXISTS', `File already exists: ${candidate}`, 'Choose a new filename; use office_set or office_add for an existing file.');
  }
  if (operation !== 'create' && (!existing || !existing.isFile())) {
    throw new OfficeError('FILE_MISSING', `Document does not exist: ${candidate}`, 'Create the document first or provide an existing file path.');
  }
  const resolved = existing ? await realpath(candidate) : path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
  const approved = [workspace];
  for (const raw of scope.approvedPaths ?? []) {
    if (typeof raw === 'string' && path.isAbsolute(raw)) approved.push(await realpath(raw));
  }
  if (!approved.some((root) => within(resolved, root) || root === resolved)) {
    throw new OfficeError('PATH_OUTSIDE_WORKSPACE', `Document is outside the approved workspace: ${candidate}`, 'Use a workspace path or ask the user to approve this absolute path through Kiki.');
  }
  return resolved;
}
