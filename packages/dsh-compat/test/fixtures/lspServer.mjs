import { writeFileSync } from 'node:fs';

const documents = new Map();
let input = Buffer.alloc(0);
let shutdownRequested = false;
let terminated = false;
let exitCode = 0;

function writeMarker(filePath, value) {
  if (!filePath) return;
  try {
    writeFileSync(filePath, JSON.stringify(value));
  } catch (error) {
    process.stderr.write(`fixture marker write failed: ${error.message}\n`);
  }
}

writeMarker(process.env['DSH_TEST_PID_FILE'], { pid: process.pid, kind: 'lsp' });

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function finish(reason, code = 0) {
  if (terminated) return;
  terminated = true;
  exitCode = code;
  writeMarker(process.env['DSH_TEST_EXIT_FILE'], { pid: process.pid, kind: 'lsp', reason });
  process.stdin.pause();
  process.stdin.destroy();
  process.exitCode = exitCode;
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineEnd(text, starts, line) {
  let end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  if (end > starts[line] && text[end - 1] === '\r') end -= 1;
  return end;
}

function offsetAt(text, position) {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)) return -1;
  const starts = lineStarts(text);
  if (position.line < 0 || position.line >= starts.length || position.character < 0) return -1;
  return Math.min(starts[position.line] + position.character, lineEnd(text, starts, position.line));
}

function positionAt(text, offset) {
  const starts = lineStarts(text);
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low, character: offset - starts[low] };
}

function rangeAt(text, start, end) {
  return { start: positionAt(text, start), end: positionAt(text, end) };
}

function identifierPart(character) {
  return character !== undefined && /[\w$]/.test(character);
}

function identifierAt(text, position) {
  const offset = offsetAt(text, position);
  if (offset < 0 || offset > text.length) return undefined;
  let start = offset;
  let end = offset;
  if (!identifierPart(text[offset])) {
    if (offset === 0 || !identifierPart(text[offset - 1])) return undefined;
    start -= 1;
    end -= 1;
  }
  while (start > 0 && identifierPart(text[start - 1])) start -= 1;
  while (end < text.length && identifierPart(text[end])) end += 1;
  return { name: text.slice(start, end), start, end };
}

function exportedAlpha(text) {
  const match = /\bexport\s+function\s+alpha\b/.exec(text);
  if (!match) return undefined;
  const start = match.index + match[0].lastIndexOf('alpha');
  return { start, end: start + 'alpha'.length };
}

function alphaCalls(text, declaration) {
  const locations = [];
  const expression = /\balpha\s*\(/g;
  let match;
  while ((match = expression.exec(text)) !== null) {
    if (match.index !== declaration.start) {
      locations.push({ start: match.index, end: match.index + 'alpha'.length });
    }
  }
  return locations;
}

function symbolLocation(uri, text, symbolRange) {
  return { uri, range: rangeAt(text, symbolRange.start, symbolRange.end) };
}

function getDocument(uri) {
  return typeof uri === 'string' ? documents.get(uri) : undefined;
}

function applyChange(text, change) {
  if (!change || typeof change.text !== 'string' || !change.range) return change?.text ?? text;
  const start = offsetAt(text, change.range.start);
  const end = offsetAt(text, change.range.end);
  if (start < 0 || end < start) return text;
  return text.slice(0, start) + change.text + text.slice(end);
}

function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === 'initialize') {
    respond(id, {
      capabilities: {
        positionEncoding: 'utf-16',
        textDocumentSync: { openClose: true, change: 2 },
        definitionProvider: true,
        referencesProvider: true,
        implementationProvider: true,
        hoverProvider: true,
      },
      serverInfo: { name: 'dsh-compat-lsp-fixture', version: '1.0.0' },
    });
    return;
  }
  if (method === 'shutdown') {
    shutdownRequested = true;
    respond(id, null);
    return;
  }
  if (method === 'textDocument/definition' || method === 'textDocument/implementation') {
    const uri = params.textDocument?.uri;
    const document = getDocument(uri);
    const declaration = document && exportedAlpha(document.text);
    const symbol = document && identifierAt(document.text, params.position);
    respond(id, declaration && symbol?.name === 'alpha' ? [symbolLocation(uri, document.text, declaration)] : null);
    return;
  }
  if (method === 'textDocument/references') {
    const uri = params.textDocument?.uri;
    const document = getDocument(uri);
    const declaration = document && exportedAlpha(document.text);
    const symbol = document && identifierAt(document.text, params.position);
    if (!document || !declaration || symbol?.name !== 'alpha') {
      respond(id, []);
      return;
    }
    const matches = alphaCalls(document.text, declaration);
    if (params.context?.includeDeclaration) matches.unshift(declaration);
    respond(id, matches.map((match) => symbolLocation(uri, document.text, match)));
    return;
  }
  if (method === 'textDocument/hover') {
    const uri = params.textDocument?.uri;
    const document = getDocument(uri);
    const declaration = document && exportedAlpha(document.text);
    const symbol = document && identifierAt(document.text, params.position);
    if (!document || !declaration || symbol?.name !== 'alpha') {
      respond(id, null);
      return;
    }
    respond(id, {
      contents: {
        kind: 'markdown',
        value: '`alpha` is an exported function.\n\n```typescript\nexport function alpha()\n```',
      },
      range: rangeAt(document.text, symbol.start, symbol.end),
    });
    return;
  }
  respondError(id, -32601, `Method not found: ${method}`);
}

function handleNotification(message) {
  const { method, params = {} } = message;
  if (method === 'exit') {
    finish('exit', shutdownRequested ? 0 : 1);
  } else if (method === 'textDocument/didOpen') {
    const document = params.textDocument;
    if (typeof document?.uri === 'string' && typeof document.text === 'string') {
      documents.set(document.uri, { text: document.text, version: document.version });
    }
  } else if (method === 'textDocument/didChange') {
    const document = getDocument(params.textDocument?.uri);
    if (document && Array.isArray(params.contentChanges)) {
      for (const change of params.contentChanges) document.text = applyChange(document.text, change);
      document.version = params.textDocument?.version;
    }
  } else if (method === 'textDocument/didClose') {
    documents.delete(params.textDocument?.uri);
  }
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (Object.hasOwn(message, 'id')) {
    try {
      handleRequest(message);
    } catch (error) {
      respondError(message.id, -32603, error.message);
    }
  } else {
    handleNotification(message);
  }
}

function parseInput() {
  while (!terminated) {
    const headerEnd = input.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = input.toString('ascii', 0, headerEnd);
    const lengthHeader = header.split('\r\n').find((line) => /^content-length\s*:/i.test(line));
    const match = lengthHeader?.match(/^content-length\s*:\s*(\d+)\s*$/i);
    if (!match) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Missing or invalid Content-Length header' } });
      input = input.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) {
      finish('invalid-content-length', 1);
      return;
    }
    const frameEnd = headerEnd + 4 + length;
    if (input.length < frameEnd) return;
    const payload = input.subarray(headerEnd + 4, frameEnd);
    input = input.subarray(frameEnd);
    try {
      handleMessage(JSON.parse(payload.toString('utf8')));
    } catch (error) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } });
    }
  }
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  parseInput();
});
process.stdin.once('end', () => {
  finish('stdin-end', shutdownRequested ? 0 : 1);
});
process.stdin.once('error', (error) => {
  process.stderr.write(`fixture stdin error: ${error.message}\n`);
  finish('stdin-error', 1);
});
process.once('SIGTERM', () => {
  finish('SIGTERM', 0);
});
