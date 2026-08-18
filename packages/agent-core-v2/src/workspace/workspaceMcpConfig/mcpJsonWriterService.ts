/**
 * `workspaceMcpConfig` domain — validated MCP JSON file writer.
 *
 * Resolves the editable user and project files through the MCP config loader,
 * validates complete documents and individual server entries, applies targeted
 * object-member edits while preserving unrelated bytes, replaces the target
 * atomically, explicitly reloads `workspaceMcpConfig`, and returns the
 * authoritative post-reload file entries. Workspace-scoped.
 */

import { Error2 } from '#/_base/errors/errors';
import { CoreErrors } from '#/_base/errors/codes';
import { atomicWrite } from '#/_base/utils/fs';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { McpServerConfigSchema, type McpServerConfig } from '#/mcpCore/config-schema';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { dirname } from 'pathe';
import { z } from 'zod';

import { McpJsonWriteErrors } from './errors';
import {
  parseMcpJsonText,
  readMcpJson,
  resolveMcpJsonPaths,
  type McpJsonPaths,
} from './internal/config-loader';
import type {
  IMcpJsonWriter,
  McpJsonServerEntry,
  McpJsonServerList,
  McpJsonServerRemoveRequest,
  McpJsonServerUpsertRequest,
  McpJsonWriteScope,
} from './mcpJsonWriter';
import type { IWorkspaceMcpConfigService } from './workspaceMcpConfig';

type AtomicTextWriter = (path: string, text: string) => Promise<void>;

type ObjectProperty = {
  readonly key: string;
  readonly memberStart: number;
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly commaBefore?: number;
  readonly commaAfter?: number;
};

interface ObjectShape {
  readonly start: number;
  readonly end: number;
  readonly properties: readonly ObjectProperty[];
}

const serverNameSchema = z.string().trim().min(1).max(256);
const scopeSchema = z.enum(['user', 'project']);

export class McpJsonWriterService implements IMcpJsonWriter {
  declare readonly _serviceBrand: undefined;

  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly fs: IHostFileSystem,
    private readonly workspace: IWorkspaceContext,
    private readonly bootstrap: IBootstrapService,
    private readonly config: IWorkspaceMcpConfigService,
    private readonly atomicTextWriter: AtomicTextWriter = atomicWrite,
  ) {}

  list(): Promise<McpJsonServerList> {
    return this.serialize(() => this.readAuthoritative());
  }

  upsert(request: McpJsonServerUpsertRequest): Promise<McpJsonServerList> {
    return this.serialize(async () => {
      const validated = validateUpsertRequest(request);
      const paths = await this.paths();
      const filePath = pathForScope(paths, validated.scope);
      const text = await this.readTextOrEmpty(filePath);
      parseMcpJsonText(text, filePath);
      const next = editMcpJson(text, {
        kind: 'upsert',
        name: validated.name,
        config: validated.config,
      });
      parseMcpJsonText(next, filePath);
      await this.fs.mkdir(dirname(filePath), { recursive: true });
      await this.atomicTextWriter(filePath, next);
      await this.config.reload();
      return this.readAuthoritative(paths);
    });
  }

  remove(request: McpJsonServerRemoveRequest): Promise<McpJsonServerList> {
    return this.serialize(async () => {
      const validated = validateRemoveRequest(request);
      const paths = await this.paths();
      const filePath = pathForScope(paths, validated.scope);
      const text = await this.readTextOrEmpty(filePath);
      const parsed = parseMcpJsonText(text, filePath);
      if (!Object.hasOwn(parsed.mcpServers, validated.name)) {
        await this.throwMissingOrReadOnly(validated.name, validated.scope, paths);
      }
      const next = editMcpJson(text, { kind: 'remove', name: validated.name });
      parseMcpJsonText(next, filePath);
      await this.atomicTextWriter(filePath, next);
      await this.config.reload();
      return this.readAuthoritative(paths);
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.tail.catch(() => undefined).then(work);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private paths(): Promise<McpJsonPaths> {
    return resolveMcpJsonPaths({
      fs: this.fs,
      cwd: this.workspace.cwd,
      homeDir: this.bootstrap.homeDir,
    });
  }

  private async readAuthoritative(paths?: McpJsonPaths): Promise<McpJsonServerList> {
    const resolved = paths ?? await this.paths();
    const [user, project] = await Promise.all([
      readMcpJson(this.fs, resolved.user),
      readMcpJson(this.fs, resolved.project),
    ]);
    return {
      entries: [
        ...toEntries('user', user),
        ...toEntries('project', project),
      ].toSorted((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)),
    };
  }

  private async readTextOrEmpty(filePath: string): Promise<string> {
    try {
      return await this.fs.readText(filePath);
    } catch (error) {
      if (error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND) return '';
      throw error;
    }
  }

  private async throwMissingOrReadOnly(
    name: string,
    scope: McpJsonWriteScope,
    paths: McpJsonPaths,
  ): Promise<never> {
    const otherScope = scope === 'user' ? 'project' : 'user';
    const otherEntries = await readMcpJson(this.fs, pathForScope(paths, otherScope));
    if (!Object.hasOwn(otherEntries, name) && Object.hasOwn(this.config.servers(), name)) {
      throw new Error2(
        McpJsonWriteErrors.codes.MCP_WRITE_READ_ONLY,
        `MCP server "${name}" is loaded from a read-only source`,
        { details: { name, scope } },
      );
    }
    throw new Error2(
      McpJsonWriteErrors.codes.MCP_WRITE_NOT_FOUND,
      `MCP server "${name}" was not found in ${scope} scope`,
      { details: { name, scope } },
    );
  }
}

function validateUpsertRequest(request: McpJsonServerUpsertRequest): McpJsonServerUpsertRequest {
  const result = z.object({
    name: serverNameSchema,
    scope: scopeSchema,
    config: McpServerConfigSchema,
  }).strict().safeParse(request);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function validateRemoveRequest(request: McpJsonServerRemoveRequest): McpJsonServerRemoveRequest {
  const result = z.object({ name: serverNameSchema, scope: scopeSchema }).strict().safeParse(request);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

function validationError(error: z.ZodError): Error2 {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  return new Error2(CoreErrors.codes.VALIDATION_FAILED, issues[0]?.message ?? 'validation failed', {
    details: { issues },
  });
}

function pathForScope(paths: McpJsonPaths, scope: McpJsonWriteScope): string {
  return scope === 'user' ? paths.user : paths.project;
}

function toEntries(
  scope: McpJsonWriteScope,
  servers: Readonly<Record<string, McpServerConfig>>,
): McpJsonServerEntry[] {
  return Object.entries(servers).map(([name, config]) => ({ name, scope, config }));
}

function editMcpJson(
  text: string,
  operation:
    | { readonly kind: 'upsert'; readonly name: string; readonly config: McpServerConfig }
    | { readonly kind: 'remove'; readonly name: string },
): string {
  if (text.trim().length === 0) {
    if (operation.kind === 'remove') return text;
    return `${JSON.stringify({ mcpServers: { [operation.name]: operation.config } }, null, 2)}\n`;
  }

  const root = scanObject(text, skipWhitespace(text, 0));
  const mcpServers = root.properties.find((property) => property.key === 'mcpServers');
  if (mcpServers === undefined) {
    if (operation.kind === 'remove') return text;
    return insertMcpServersProperty(text, root, operation.name, operation.config);
  }

  const serversObject = scanObject(text, mcpServers.valueStart);
  const entry = serversObject.properties.find((property) => property.key === operation.name);
  if (operation.kind === 'remove') {
    if (entry === undefined) return text;
    return removeProperty(text, serversObject, entry);
  }

  if (entry !== undefined) {
    const indentation = indentationAt(text, entry.keyStart);
    const value = formatJsonValue(operation.config, indentation);
    return text.slice(0, entry.valueStart) + value + text.slice(entry.valueEnd);
  }
  return insertServerProperty(text, serversObject, operation.name, operation.config);
}

function insertMcpServersProperty(
  text: string,
  root: ObjectShape,
  name: string,
  config: McpServerConfig,
): string {
  const eol = preferredEol(text);
  const rootIndent = indentationAt(text, root.start);
  const unit = inferIndentUnit(text, root);
  const propertyIndent = `${rootIndent}${unit}`;
  const value = formatJsonValue({ [name]: config }, propertyIndent);
  const property = `${JSON.stringify('mcpServers')}: ${value}`;
  const last = root.properties.at(-1);
  if (last === undefined) {
    return text.slice(0, root.start + 1)
      + `${eol}${propertyIndent}${property}${eol}${rootIndent}`
      + text.slice(root.end);
  }
  return text.slice(0, last.valueEnd)
    + `,${eol}${propertyIndent}${property}`
    + text.slice(last.valueEnd);
}

function insertServerProperty(
  text: string,
  object: ObjectShape,
  name: string,
  config: McpServerConfig,
): string {
  const eol = preferredEol(text);
  const objectIndent = indentationAt(text, object.start);
  const unit = inferIndentUnit(text, object);
  const entryIndent = `${objectIndent}${unit}`;
  const property = `${JSON.stringify(name)}: ${formatJsonValue(config, entryIndent)}`;
  const last = object.properties.at(-1);
  if (last === undefined) {
    return text.slice(0, object.start + 1)
      + `${eol}${entryIndent}${property}${eol}${objectIndent}`
      + text.slice(object.end);
  }
  return text.slice(0, last.valueEnd)
    + `,${eol}${entryIndent}${property}`
    + text.slice(last.valueEnd);
}

function removeProperty(text: string, object: ObjectShape, property: ObjectProperty): string {
  if (object.properties.length === 1) {
    return text.slice(0, object.start + 1) + text.slice(object.end);
  }
  if (property.commaAfter !== undefined) {
    return text.slice(0, property.memberStart) + text.slice(property.commaAfter + 1);
  }
  if (property.commaBefore !== undefined) {
    return text.slice(0, property.commaBefore) + text.slice(property.valueEnd);
  }
  return text;
}

function scanObject(text: string, start: number): ObjectShape {
  if (text[start] !== '{') throw new Error('expected JSON object');
  const properties: ObjectProperty[] = [];
  let cursor = start + 1;
  let commaBefore: number | undefined;
  while (cursor < text.length) {
    const memberStart = cursor;
    cursor = skipWhitespace(text, cursor);
    if (text[cursor] === '}') return { start, end: cursor, properties };
    const keyStart = cursor;
    const keyEnd = stringEnd(text, keyStart);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    cursor = skipWhitespace(text, keyEnd);
    if (text[cursor] !== ':') throw new Error('expected JSON object colon');
    const valueStart = skipWhitespace(text, cursor + 1);
    const valueEnd = skipValue(text, valueStart);
    cursor = skipWhitespace(text, valueEnd);
    const commaAfter = text[cursor] === ',' ? cursor : undefined;
    properties.push({
      key,
      memberStart,
      keyStart,
      valueStart,
      valueEnd,
      commaBefore,
      commaAfter,
    });
    if (commaAfter === undefined) {
      cursor = skipWhitespace(text, cursor);
      if (text[cursor] !== '}') throw new Error('expected JSON object end');
      return { start, end: cursor, properties };
    }
    commaBefore = commaAfter;
    cursor = commaAfter + 1;
  }
  throw new Error('unterminated JSON object');
}

function skipValue(text: string, start: number): number {
  const first = text[start];
  if (first === '"') return stringEnd(text, start);
  if (first === '{' || first === '[') {
    const closing = first === '{' ? '}' : ']';
    const stack = [closing];
    let cursor = start + 1;
    while (cursor < text.length && stack.length > 0) {
      const char = text[cursor];
      if (char === '"') {
        cursor = stringEnd(text, cursor);
        continue;
      }
      if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if (char === stack.at(-1)) stack.pop();
      cursor += 1;
    }
    return cursor;
  }
  let cursor = start;
  while (cursor < text.length && !/[\s,}\]]/u.test(text[cursor]!)) cursor += 1;
  return cursor;
}

function stringEnd(text: string, start: number): number {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (text[cursor] === '"') return cursor + 1;
    cursor += 1;
  }
  throw new Error('unterminated JSON string');
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
  return cursor;
}

function indentationAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/u.test(prefix) ? prefix : '';
}

function inferIndentUnit(text: string, object: ObjectShape): string {
  const objectIndent = indentationAt(text, object.start);
  const first = object.properties[0];
  if (first !== undefined) {
    const propertyIndent = indentationAt(text, first.keyStart);
    if (propertyIndent.startsWith(objectIndent) && propertyIndent.length > objectIndent.length) {
      return propertyIndent.slice(objectIndent.length);
    }
  }
  return '  ';
}

function formatJsonValue(value: unknown, indentation: string): string {
  return JSON.stringify(value, null, 2).replaceAll('\n', `\n${indentation}`);
}

function preferredEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
