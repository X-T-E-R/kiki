import { readFile, writeFile, mkdir, rename, stat, rm, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const mimeFor = (format) =>
  ({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    aac: 'audio/aac',
    wav: 'audio/wav',
    flac: 'audio/flac',
    opus: 'audio/ogg',
    pcm: 'audio/pcm',
    pcmu_raw: 'audio/basic',
    pcmu_wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    gif: 'image/gif',
    json: 'application/json',
    srt: 'application/x-subrip',
  }[format.toLowerCase()] ?? 'application/octet-stream');
export function check(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { submission: 'not_sent', code: 'invalid_request' });
}
export function options(request, allowed) {
  const value = request.options ?? {};
  check(
    Object.keys(value).every((key) => allowed.includes(key)),
    `Unsupported options: ${Object.keys(value)
      .filter((key) => !allowed.includes(key))
      .join(', ')}`
  );
  return value;
}
export function fields(request, forbidden) {
  for (const key of forbidden) check(request[key] === undefined, `${key} is not supported by this adapter`);
}
export function oneOf(value, allowed, name) {
  if (value !== undefined) check(allowed.includes(value), `${name} must be one of ${allowed.join(', ')}`);
}
export function range(value, min, max, name, integer = false) {
  if (value !== undefined)
    check(
      typeof value === 'number' && value >= min && value <= max && (!integer || Number.isInteger(value)),
      `${name} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`
    );
}
export function decode(value, encoding = 'base64') {
  const valid =
    encoding === 'hex' ? /^(?:[0-9a-fA-F]{2})+$/ : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (typeof value !== 'string' || value.length === 0 || !valid.test(value))
    throw Object.assign(new Error(`Invalid or empty ${encoding} output`), {
      submission: 'accepted',
      code: 'invalid_media',
    });
  return Buffer.from(value, encoding);
}
export function failed(error, submission = 'accepted', artifacts = []) {
  return {
    state: 'failed',
    artifacts,
    error: {
      code: error.code ?? 'provider_error',
      message: String(error.message ?? error),
      submission: error.submission ?? submission,
    },
  };
}
export function pending(data, phase = 'generation', artifacts = []) {
  return { state: 'pending', handle: { version: 1, data }, phase, retryAfterMs: 3000, artifacts };
}
export async function guarded(action, submission) {
  try {
    return await action();
  } catch (error) {
    return failed(error, submission);
  }
}
function imageFormat(data) {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpeg';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return undefined;
}
export async function runtime(context, fetchImpl = globalThis.fetch, minimaxApiRoot = false) {
  let connection;
  if (context.settings.connectionId) {
    check(typeof context.connection === 'function', 'Selected Kiki connection helper is unavailable');
    try { connection = await context.connection(); }
    catch { throw Object.assign(new Error('Selected Kiki connection could not be resolved; no fallback credentials were used'), { code: 'connection_unavailable', submission: 'not_sent' }); }
    check(connection, 'Selected Kiki connection is unavailable; no fallback credentials were used');
  }
  let base = String((connection ? connection.baseUrl : context.settings.baseUrl) ?? '').replace(/\/+$/, '');
  if (connection && minimaxApiRoot) base = base.replace(/\/v[12]$/, '');
  check(/^https?:\/\//.test(base), 'Configure an HTTP(S) baseUrl');
  const auth = connection ? { ...connection.headers } : context.settings.apiKey ? { Authorization: `Bearer ${context.settings.apiKey}` } : {};
  const endpoint = (suffix) => `${base}/${suffix.replace(/^\/+/, '')}`;
  const send = async (url, { method = 'GET', body, headers = {}, authenticate = true, followDownloadRedirects = false } = {}) => {
    let requestHeaders = new Headers(headers);
    if (authenticate && new URL(url).origin === new URL(base).origin) {
      if (connection) {
        for (const name of ['authorization', 'x-api-key', 'x-goog-api-key']) requestHeaders.delete(name);
        for (const [name, value] of Object.entries(auth)) requestHeaders.set(name, value);
      } else {
        for (const [name, value] of Object.entries(auth)) if (!requestHeaders.has(name)) requestHeaders.set(name, value);
      }
    }
    let currentUrl = url;
    for (let redirects = 0; ; redirects++) {
      if (context.signal.aborted)
        throw Object.assign(new Error('Stopped before sending the HTTP request'), {
          submission: method === 'POST' ? 'not_sent' : 'accepted',
          code: 'local_stopped',
        });
      let response;
      try {
        response = await fetchImpl(currentUrl, {
          method,
          headers: Object.fromEntries(requestHeaders),
          body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
          signal: context.signal,
          // Native fetch strips Authorization but not arbitrary API-key/identity
          // headers on redirects. Handle only media/input GET redirects below.
          redirect: 'manual',
        });
      } catch {
        throw Object.assign(
          new Error(
            context.signal.aborted
              ? 'Local reception stopped; remote generation may continue and incur charges'
              : 'Network response lost; do not resubmit automatically'
          ),
          {
            submission: method === 'POST' ? 'unknown' : 'accepted',
            code: context.signal.aborted ? 'local_stopped' : 'transport_error',
          }
        );
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (!followDownloadRedirects || method !== 'GET')
          throw Object.assign(new Error('API endpoint redirected; configure its direct URL. The request was not forwarded.'), {
            code: 'http_redirect', submission: method === 'POST' ? 'unknown' : 'accepted',
          });
        let next;
        try {
          const location = response.headers.get('location');
          if (!location || redirects >= 20) throw new Error();
          next = new URL(location, currentUrl);
          if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) throw new Error();
        } catch {
          throw Object.assign(new Error('Media redirect is invalid or exceeds 20 hops'), { code: 'redirect_failed', submission: 'accepted' });
        }
        // Preserve the complete header set only within the current origin.
        // Unknown provider-specific fields may be credentials, so clear all on
        // a cross-origin hop and never reattach them later in the redirect chain.
        if (next.origin !== new URL(currentUrl).origin) requestHeaders = new Headers();
        currentUrl = next.href;
        continue;
      }
      if (!response.ok)
        throw Object.assign(new Error(`Provider HTTP ${response.status}`), {
          code: `http_${response.status}`,
          submission:
            method === 'POST' && response.status < 500 && response.status !== 408
              ? 'rejected'
              : method === 'POST'
              ? 'unknown'
              : 'accepted',
        });
      return response;
    }
  };
  const json = async (url, body, headers, method = body === undefined ? 'GET' : 'POST') => {
    const response = await send(url, {
      method,
      body,
      headers: body instanceof FormData ? headers : { 'Content-Type': 'application/json', ...headers },
    });
    let value;
    try {
      value = await response.json();
    } catch {
      throw Object.assign(new Error('Malformed provider JSON response'), {
        submission: method === 'POST' ? 'unknown' : 'accepted',
        code: 'invalid_response',
      });
    }
    if (value.error || (value.base_resp && value.base_resp.status_code !== 0))
      throw Object.assign(
        new Error(value.error?.message ?? value.base_resp.status_msg ?? 'Provider rejected request'),
        {
          submission: method === 'POST' ? 'rejected' : 'accepted',
          code: String(value.error?.code ?? value.base_resp?.status_code ?? 'provider_error'),
        }
      );
    return value;
  };
  const write = async (
    bytes,
    name,
    kind,
    mime = mimeFor(path.extname(name).slice(1)),
    complete = true,
    role = 'original',
    metadata
  ) => {
    context.signal.throwIfAborted();
    await mkdir(context.stagingDir, { recursive: true });
    const dest = path.join(context.stagingDir, name);
    const temporary = `${dest}.part-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, dest);
    } finally {
      await rm(temporary, { force: true });
    }
    return { path: dest, name, mime, kind, role, complete, metadata };
  };
  const download = async (url, name, kind, headers = {}, mime) => {
    const response = await send(url, { headers, followDownloadRedirects: true });
    if (!response.body)
      throw Object.assign(new Error('Empty download body'), { submission: 'accepted', code: 'empty_media' });
    const type = response.headers.get('content-type')?.split(';')[0];
    if (type && /(?:json|text\/html)/.test(type))
      throw Object.assign(new Error('Download returned an error document, not media'), {
        code: 'invalid_media',
        submission: 'accepted',
      });
    await mkdir(context.stagingDir, { recursive: true });
    let dest = path.join(context.stagingDir, name);
    const temporary = `${dest}.part-${randomUUID()}`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }), {
        signal: context.signal,
      });
      const size = (await stat(temporary)).size;
      if (
        !size ||
        (response.headers.get('content-length') &&
          !response.headers.has('content-encoding') &&
          size !== Number(response.headers.get('content-length')))
      )
        throw Object.assign(new Error('Empty or truncated media download'), {
          code: 'truncated_media',
          submission: 'accepted',
        });
      if (kind === 'image') {
        const handle = await open(temporary, 'r');
        const header = Buffer.alloc(16);
        try {
          await handle.read(header, 0, 16, 0);
        } finally {
          await handle.close();
        }
        const format = imageFormat(header);
        if (format) {
          name = `${path.parse(name).name}.${format}`;
          dest = path.join(context.stagingDir, name);
          mime = mimeFor(format);
        }
      }
      await rename(temporary, dest);
      return {
        path: dest,
        name,
        kind,
        mime: mime ?? type ?? mimeFor(path.extname(name).slice(1)),
        role: 'original',
        complete: true,
      };
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const bytes = async (ref) => {
    check(!ref.file_id, 'Host must resolve file_id before provider execution');
    if (ref.path)
      return {
        data: await readFile(ref.path),
        mime: mimeFor(path.extname(ref.path).slice(1)),
        name: path.basename(ref.path),
      };
    check(ref.url, 'Missing input reference');
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(ref.url);
    if (match) return { data: decode(match[2]), mime: match[1], name: 'input' };
    const response = await send(ref.url, { authenticate: false, followDownloadRedirects: true });
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
      name: 'input',
    };
  };
  const mediaUrl = async (ref, publicOnly = false) => {
    check(!ref.file_id, 'Host must resolve file_id before provider execution');
    if (ref.url && /^https?:\/\//.test(ref.url)) return ref.url;
    check(!publicOnly, 'This endpoint requires a public media URL; no implicit upload is performed');
    const file = await bytes(ref);
    return `data:${file.mime};base64,${file.data.toString('base64')}`;
  };
  const authHeaders = (fallback) => connection ? { ...auth } : fallback;
  return { endpoint, send, json, write, download, bytes, mediaUrl, authHeaders, baseUrl: base };
}
export async function* events(response, signal) {
  if (!response.body) throw new Error('Missing SSE stream');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim())
    throw Object.assign(new Error('Truncated SSE event at EOF'), { code: 'incomplete_stream', submission: 'accepted' });
}
export async function imageResults(values, rt, format = 'png', usage) {
  if (!Array.isArray(values) || values.length === 0)
    return failed({ code: 'missing_output', message: 'Provider returned no images' });
  const artifacts = [];
  const errors = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    try {
      if (value.url) artifacts.push(await rt.download(value.url, `image-${index + 1}.${format}`, 'image'));
      else {
        const data = decode(value.b64_json);
        const actual = imageFormat(data) ?? format;
        artifacts.push(await rt.write(data, `image-${index + 1}.${actual}`, 'image', mimeFor(actual)));
      }
    } catch (error) {
      errors.push({ item: String(index), code: error.code ?? 'download_failed', message: error.message });
    }
  }
  return errors.length > 0
    ? {
        state: 'failed',
        artifacts,
        error: {
          code: 'partial_images',
          message: 'Some image outputs could not be delivered',
          submission: 'accepted',
          items: errors,
        },
        usage,
      }
    : { state: 'complete', artifacts, usage };
}
export async function videoDownload(handle, rt, url, headers = {}, effective, usage) {
  if (!url) return failed({ code: 'missing_output', message: 'Completed task returned no video URL' });
  try {
    return { state: 'complete', artifacts: [await rt.download(url, 'video.mp4', 'video', headers)], effective, usage };
  } catch (error) {
    if (error.code === 'local_stopped') throw error;
    return {
      ...pending(handle.data, 'download'),
      warnings: ['Generation accepted; download failed. Resume re-queries/downloads only.'],
    };
  }
}

export async function receiveAudio(response, context, name, mime, metadata) {
  const type = response.headers.get('content-type') ?? '';
  if (!response.body || /(?:json|text\/html|text\/event-stream)/.test(type))
    return failed({ code: 'invalid_media', message: 'Expected a binary audio response' });
  await mkdir(context.stagingDir, { recursive: true });
  const destination = path.join(context.stagingDir, name);
  const temporary = `${destination}.part-${randomUUID()}`;
  const file = await open(temporary, 'wx');
  let size = 0;
  let receptionError;
  try {
    for await (const chunk of response.body) {
      context.signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      await file.write(bytes);
      size += bytes.length;
    }
    const length = response.headers.get('content-length');
    if (!size || (length !== null && !response.headers.has('content-encoding') && size !== Number(length)))
      throw Object.assign(new Error('Audio is empty or truncated'), { code: 'truncated_media' });
  } catch (error) {
    receptionError = Object.assign(
      new Error(
        context.signal.aborted
          ? 'Local audio reception stopped; remote synthesis may continue and incur charges'
          : error.message
      ),
      { code: context.signal.aborted ? 'local_stopped' : error.code ?? 'incomplete_audio', submission: 'accepted' }
    );
  } finally {
    await file.close();
  }
  const artifacts = [];
  if (size) {
    await rename(temporary, destination);
    artifacts.push({ path: destination, name, kind: 'audio', mime, role: 'original', complete: !receptionError, metadata });
  } else await rm(temporary, { force: true });
  return receptionError ? failed(receptionError, 'accepted', artifacts) : { state: 'complete', artifacts };
}
