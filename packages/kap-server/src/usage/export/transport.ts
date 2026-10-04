import { createHash, createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { planHttpConnection, validateHttpEndpoint } from '@nb-im/core';
import type { UsageExportDestination } from '@kiki/protocol';
import type { UsageExportHttpRequest, UsageExportHttpResponse } from './adapter';
import type { UsageExportSecretStore } from './secrets';

export function validateExportTarget(destination: UsageExportDestination['target']): void {
  if (destination.kind === 'script') return;
  const url = validateHttpEndpoint(destination.endpoint, destination.private_grant);
  if (url.search) throw new Error('endpoint-query-not-allowed');
  if (destination.kind === 'webhook' && destination.authentication === 'bearer' && url.protocol !== 'https:') throw new Error('bearer-requires-https');
}
export function retryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value); const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 86_400_000) : undefined;
}
export async function postUsageExport(
  destination: UsageExportDestination,
  request: UsageExportHttpRequest,
  secrets: UsageExportSecretStore,
  batchId: string,
  signal: AbortSignal,
  permit: () => boolean,
): Promise<UsageExportHttpResponse> {
  const target = destination.target; if (target.kind === 'script') throw new Error('script-has-no-http-target');
  validateExportTarget(target);
  if (request.contentType !== 'application/json' || request.body.byteLength > 1_048_576) throw new Error('export-body-too-large');
  const plan = await planHttpConnection({ url: target.endpoint, body: '', content_type: 'application/json', private_grant: target.private_grant });
  const secret = await secrets.read(destination.id, destination.credential_storage);
  const headers: Record<string, string | number> = { 'content-type': 'application/json', 'content-length': request.body.byteLength };
  if (request.contentEncoding !== undefined) headers['content-encoding'] = request.contentEncoding;
  const authentication = target.kind === 'vibe' ? 'bearer' : target.authentication;
  if (authentication !== 'none' && secret === undefined) throw new Error('credential-unavailable');
  if (authentication === 'bearer') {
    if (plan.url.protocol !== 'https:' || !/^[A-Za-z0-9._~+/-]{1,1024}$/.test(secret ?? '')) throw new Error('invalid-credential');
    headers['authorization'] = `Bearer ${secret}`;
  }
  if (authentication === 'hmac') {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyHash = createHash('sha256').update(request.body).digest('hex');
    headers['x-kiki-usage-timestamp'] = timestamp; headers['x-kiki-usage-batch'] = batchId;
    headers['x-kiki-usage-signature'] = createHmac('sha256', secret ?? '').update(`${timestamp}\n${batchId}\n${bodyHash}`).digest('hex');
  }
  if (signal.aborted || !permit()) throw new Error('export-dispatch-revoked');
  return new Promise((resolve, reject) => {
    const transport = plan.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport({ hostname: plan.url.hostname, port: plan.url.port, path: plan.url.pathname, method: 'POST', headers, agent: false, family: plan.family, signal, lookup: (_host, _options, callback) => callback(null, plan.ip, plan.family) }, (res) => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (value: Buffer) => { bytes += value.length; if (bytes > 65_536) req.destroy(new Error('export-response-too-large')); else chunks.push(value); });
      res.on('aborted', () => reject(new Error('export-response-aborted'))); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), retryAfterMs: retryAfter(typeof res.headers['retry-after'] === 'string' ? res.headers['retry-after'] : undefined) }));
    });
    const timer = setTimeout(() => req.destroy(new Error('export-timeout')), 60_000); timer.unref();
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(request.body);
  });
}
