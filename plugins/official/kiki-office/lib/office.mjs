import { admitFile, OfficeError } from './paths.mjs';
import { findBinary, runProcess } from './binary.mjs';
import { guardPackage } from './package-guard.mjs';
import { renderPreview } from './preview.mjs';

const MAX_RESULT = 16_384;
const MAX_ROWS = 200;
const MAX_CELLS = 200;
const MAX_COMMANDS = 32;
const MAX_PROPS = 32;

function object(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OfficeError('ARGUMENT_INVALID', 'Expected an object of tool arguments.', 'Pass named parameters from the tool schema.');
  return input;
}
function text(value, field, max = 4096) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new OfficeError('ARGUMENT_INVALID', `Invalid ${field}.`, `Provide a nonempty ${field} of at most ${max} characters.`);
  return value;
}
function properties(value) {
  const props = object(value);
  const entries = Object.entries(props);
  if (entries.length === 0 || entries.length > MAX_PROPS) throw new OfficeError('ARGUMENT_INVALID', 'Property count must be between 1 and 32.', 'Provide only the properties you need to change.');
  return entries.flatMap(([key, entry]) => {
    if (!/^[\w.-]{1,64}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof entry) || String(entry).length > 4096) throw new OfficeError('ARGUMENT_INVALID', `Invalid property: ${key}`, 'Use simple named text, number, or boolean property values.');
    return ['--prop', `${key}=${String(entry)}`];
  });
}
function windowOutput(output, rows = MAX_ROWS, cells = MAX_CELLS) {
  const lines = output.split(/\r?\n/);
  const rowLimit = Math.min(MAX_ROWS, rows);
  const cellLimit = Math.min(MAX_CELLS, cells);
  let used = 0;
  const selected = [];
  for (const line of lines) {
    const found = line.match(/(?:^|\t)[A-Z]{1,3}\d+=/g)?.length ?? 0;
    if (selected.length >= rowLimit || used + found > cellLimit) break;
    used += found;
    selected.push(line);
  }
  let body = selected.join('\n');
  const limited = selected.length < lines.length || Buffer.byteLength(body) > MAX_RESULT;
  if (Buffer.byteLength(body) > MAX_RESULT) body = Buffer.from(body).subarray(0, MAX_RESULT).toString('utf8');
  return `${body}${limited ? '\n> Truncated: output window reached; narrow the range, selector, or row/cell limits.' : ''}`;
}
function parseResult(stdout) {
  try { return JSON.parse(stdout); } catch { return stdout; }
}
function errorResult(error) {
  return { success: false, error: { code: error.code ?? 'ENGINE_ERROR', message: error.message ?? String(error), suggestion: error.suggestion ?? 'Check the OfficeCLI command, path and document, then retry.' } };
}

export function createOfficeCore({ locateBinary = findBinary, invoke = runProcess, scope }) {
  async function run(name, raw, context = {}) {
    try {
      const args = object(raw);
      const file = await admitFile(args.file, name === 'office_create' ? 'create' : 'open', scope);
      if (name !== 'office_create' && ['office_set', 'office_add', 'office_remove', 'office_batch'].includes(name)) await guardPackage(file);
      const binary = await locateBinary({ binaryPath: scope?.binaryPath, signal: context.signal });
      if (name === 'office_preview') {
        if (args.mode !== undefined) throw new OfficeError('ARGUMENT_INVALID', 'Preview mode is not a tool parameter.', 'Use office_preview for PNG or outline; HTML is reserved for the panel.');
        const rendered = await renderPreview(binary, file, { page: args.page, signal: context.signal, imageIn: context.imageIn });
        return { success: true, data: rendered };
      }
      let cli;
      let input;
      switch (name) {
        case 'office_create': cli = ['create', file, '--json']; break;
        case 'office_get': cli = ['get', file, text(args.path, 'path', 512), '--depth', String(Math.min(Math.max(args.depth ?? 1, 0), 3)), '--json']; break;
        case 'office_query': cli = ['query', file, text(args.selector, 'selector', 512), '--json']; break;
        case 'office_set':
          cli = ['set', file, text(args.path, 'path', 512)];
          if (args.find !== undefined) cli.push('--find', text(args.find, 'find'));
          if (args.replace !== undefined) cli.push('--replace', text(args.replace, 'replace'));
          if (args.props !== undefined) cli.push(...properties(args.props));
          if (args.replace === undefined && args.props === undefined) throw new OfficeError('ARGUMENT_INVALID', 'Set needs replace or props.', 'Supply replacement text or properties.');
          cli.push('--json'); break;
        case 'office_add':
          cli = ['add', file, text(args.parent, 'parent', 512), '--type', text(args.type, 'type', 64), ...(args.props === undefined ? [] : properties(args.props)), '--json']; break;
        case 'office_remove': cli = ['remove', file, text(args.path, 'path', 512), '--json']; break;
        case 'office_view': {
          const mode = args.mode ?? 'text';
          if (!['text', 'annotated', 'outline', 'stats', 'issues'].includes(mode)) throw new OfficeError('ARGUMENT_INVALID', 'Unsupported view mode.', 'Use text, annotated, outline, stats or issues.');
          cli = ['view', file, mode, '--max-lines', String(Math.min(MAX_ROWS, args.maxSheetRows ?? MAX_ROWS))];
          if (args.range !== undefined) cli.push('--range', text(args.range, 'range', 512));
          if (args.start !== undefined) cli.push('--start', String(args.start));
          if (args.end !== undefined) cli.push('--end', String(args.end));
          break;
        }
        case 'office_batch': {
          const commands = args.commands;
          if (!Array.isArray(commands) || commands.length === 0 || commands.length > MAX_COMMANDS) throw new OfficeError('ARGUMENT_INVALID', 'Batch must have 1–32 commands.', 'Split the batch into smaller atomic groups.');
          for (const command of commands) {
            object(command);
            if (!['add', 'set', 'remove'].includes(command.command) || typeof (command.path ?? command.parent) !== 'string' || Object.keys(command).some((key) => !['command', 'path', 'parent', 'type', 'props', 'find', 'replace'].includes(key))) throw new OfficeError('ARGUMENT_INVALID', 'Batch contains unsupported operations.', 'Use add, set, or remove with a semantic path and supported fields.');
            if (command.command === 'add' && (typeof command.parent !== 'string' || typeof command.type !== 'string')) throw new OfficeError('ARGUMENT_INVALID', 'Batch add requires parent and type.', 'Pass an existing parent semantic path and an element type.');
            if (command.command !== 'add' && typeof command.path !== 'string') throw new OfficeError('ARGUMENT_INVALID', 'Batch set/remove requires a path.', 'Pass an exact semantic path.');
            if (command.props !== undefined) properties(command.props);
            if (command.find !== undefined) text(command.find, 'find');
            if (command.replace !== undefined) text(command.replace, 'replace');
          }
          cli = ['batch', file, '--json']; input = JSON.stringify(commands); break;
        }
        default: throw new OfficeError('ARGUMENT_INVALID', `Unknown tool: ${name}`, 'Use a declared Office tool.');
      }
      const { code, stdout, stderr } = await invoke(binary, cli, { input, signal: context.signal, maxBytes: 128 * 1024 });
      const result = parseResult(stdout);
      if (code !== 0 || (result && typeof result === 'object' && (result.success === false || result.error || result.data?.atomicRolledBack))) {
        const detail = typeof result === 'object' ? result.error : undefined;
        throw new OfficeError(detail?.code ?? 'ENGINE_ERROR', detail?.message ?? (stderr || stdout || `OfficeCLI exited with code ${code}`), 'Inspect the path and element schema with office_get or office_query, then retry.');
      }
      if (name !== 'office_view' && typeof result === 'object' && result !== null) {
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized) > MAX_RESULT) throw new OfficeError('RESULT_TOO_LARGE', 'Structured result exceeds the fixed window.', 'Narrow the selector or use a more precise semantic path.');
        return { success: true, data: serialized };
      }
      return { success: true, data: windowOutput(stdout, args.maxSheetRows, args.maxCells) };
    } catch (error) { return errorResult(error); }
  }
  return { run };
}
