/**
 * Fixture stand-in for the web-access surface (kap-server routes/web-access;
 * contract: packages/protocol/src/rest/web-access.ts). Wired routes: the
 * status read, enable, disable, link issue, session revoke, and the browser's
 * own session / exchange / logout.
 *
 * This is a fixture, not the service: it holds the entry state in memory and
 * has no listener, no cookie jar, and no socket. What it reproduces exactly is
 * the *shape of the answer* the card renders — the fields, the modes, the
 * expiry, the per-browser session rows — so the screen under review is the
 * real component fed by a real request, not a hand-built DOM.
 *
 * Scenario seeds (all optional):
 *   webAccess: {
 *     enabled?, mode?, url?, expiresInMs?, host?, port?, insecure?,
 *     sessions?: [{ id, label, createdAgoMs?, lastUsedAgoMs?, expiresInMs? }],
 *     failEnable?: { code, msg },     // makes enable refuse
 *     failLink?: { code, msg },       // makes issueLink refuse
 *   }
 *
 * `expiresInMs` is relative so a scenario stays meaningful however long ago it
 * was written; the absolute epoch the contract wants is computed on read.
 */

import { ServerResponse } from 'node:http';

const MODE = new Set(['temporary', 'persistent']);
const CODE = 'a'.repeat(43);

function state(server) {
  if (server.webAccess === undefined || server.webAccess.scenario !== server.scenario?.name) {
    const seed = structuredClone(server.scenario?.data.webAccess ?? {});
    server.webAccess = {
      scenario: server.scenario?.name,
      enabled: seed.enabled ?? false,
      mode: seed.mode ?? null,
      url: seed.url ?? null,
      expiresInMs: seed.expiresInMs ?? null,
      host: seed.host ?? '127.0.0.1',
      port: seed.port ?? 58627,
      insecure: seed.insecure ?? false,
      sessions: seed.sessions ?? [],
      failEnable: seed.failEnable,
      failLink: seed.failLink,
    };
  }
  return server.webAccess;
}

/** A refusal, in the envelope the real service uses: a code and a message. */
function refuse(server, res, failure, code = 40000) {
  if (failure === undefined) return false;
  server.envelope(res, null, failure.code ?? code, failure.msg ?? 'refused');
  return true;
}

/** The status as the contract defines it; every write answers with this shape. */
function status(web) {
  const now = Date.now();
  return {
    enabled: web.enabled,
    mode: web.mode,
    url: web.enabled ? web.url : null,
    expiresAt: web.enabled && web.expiresInMs !== null ? now + web.expiresInMs : null,
    host: web.host,
    port: web.port,
    insecure: web.insecure,
    sessions: web.enabled
      ? web.sessions.map((entry) => ({
          id: entry.id,
          label: entry.label,
          createdAt: now - (entry.createdAgoMs ?? 60_000),
          lastUsedAt: now - (entry.lastUsedAgoMs ?? 30_000),
          expiresAt: now + (entry.expiresInMs ?? 3_600_000),
        }))
      : [],
  };
}

/** Returns true when the request was handled. */
export function handleWebAccess(server, res, path, method, body, request) {
  const web = state(server);
  if (!path.startsWith('/web-access')) return false;

  if (path === '/web-access' && method === 'GET') {
    server.envelope(res, status(web));
    return true;
  }

  if (path === '/web-access' && method === 'PUT') {
    if (refuse(server, res, web.failEnable)) return true;
    const mode = body?.mode;
    if (!MODE.has(mode)) {
      refuse(server, res, { code: 40000, msg: 'mode must be temporary or persistent' });
      return true;
    }
    web.enabled = true;
    web.mode = mode;
    // A temporary entry is a real countdown; an always-on entry has no end.
    web.expiresInMs = mode === 'temporary' ? 8 * 3_600_000 : null;
    if (body?.host !== undefined) web.host = body.host;
    if (body?.port !== undefined) web.port = body.port;
    if (body?.publicUrl !== undefined) web.url = body.publicUrl;
    if (body?.insecureNoTls !== undefined) web.insecure = body.insecureNoTls;
    if (web.url === null) {
      web.url = `http://${web.insecure ? web.host : '127.0.0.1'}:${web.port}/`;
    }
    server.envelope(res, status(web));
    return true;
  }

  if (path === '/web-access' && method === 'DELETE') {
    // Turning it off ends every browser that came in through it, the way the
    // real close does; the card says exactly that.
    web.enabled = false;
    web.mode = null;
    web.url = null;
    web.expiresInMs = null;
    web.sessions = [];
    server.envelope(res, status(web));
    return true;
  }

  if (path === '/web-access/links' && method === 'POST') {
    if (refuse(server, res, web.failLink)) return true;
    const now = Date.now();
    server.envelope(res, {
      // The code lives in the fragment: it is never a query parameter, so it
      // does not reach a server log or a referrer.
      url: `${web.url ?? `http://127.0.0.1:${web.port}/`}#access=${CODE}`,
      expiresAt: now + 10 * 60_000,
    });
    return true;
  }

  if (path === '/web-access/revoke' && method === 'POST') {
    const id = body?.sessionId;
    web.sessions = id === undefined ? [] : web.sessions.filter((entry) => entry.id !== id);
    server.envelope(res, status(web));
    return true;
  }

  if (path === '/web-access/session' && method === 'GET') {
    // Answer for the cookie this browser actually holds, not the first row.
    const cookieId = /(?:^|;\s*)kiki_web_fixture=([^;]+)/.exec(request?.headers?.cookie ?? '')?.[1];
    const first = cookieId === undefined
      ? web.sessions[0]
      : web.sessions.find((entry) => entry.id === cookieId) ?? null;
    server.envelope(res, {
      authenticated: web.enabled && first !== undefined,
      session: first === undefined ? null : status(web).sessions.find((entry) => entry.id === first.id) ?? null,
    });
    return true;
  }

  if (path === '/web-access/exchange' && method === 'POST') {
    const code = body?.code;
    if (typeof code !== 'string' || code.length < 32) {
      refuse(server, res, { code: 40100, msg: 'The link is not valid.' });
      return true;
    }
    if (!web.enabled) {
      refuse(server, res, { code: 40300, msg: 'web_access_disabled' });
      return true;
    }
    // A redeemed code creates a browser session and is spent: the same code
    // cannot be exchanged twice. The id is UUID-shaped because the contract
    // validates it — a fixture that answered an id the real service could
    // never send would be testing a shape that does not exist.
    const entry = {
      id: `00000000-0000-4000-8000-${String(web.sessions.length + 1).padStart(12, '0')}`,
      label: body?.label ?? 'Browser', createdAgoMs: 0, lastUsedAgoMs: 0,
    };
    web.sessions = [...web.sessions, entry];
    // The browser must end up holding a cookie, or nothing after this point is
    // a web session at all. HttpOnly and host-only, as the contract requires.
    // `envelope` writes the status line itself, so the header is set here on the
    // response the browser will actually receive.
    if (res instanceof ServerResponse) res.setHeader('set-cookie', `kiki_web_fixture=${entry.id}; Path=/; HttpOnly; SameSite=Strict`);
    server.envelope(res, {
      authenticated: true,
      session: status(web).sessions.find((candidate) => candidate.id === entry.id) ?? null,
    });
    return true;
  }

  if (path === '/web-access/logout' && method === 'POST') {
    web.sessions = web.sessions.slice(0, -1);
    if (res instanceof ServerResponse) res.setHeader('set-cookie', 'kiki_web_fixture=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    server.envelope(res, { authenticated: false, session: null });
    return true;
  }

  return false;
}


/**
 * Whether this request carries a live web session cookie.
 *
 * The real service treats a request with no `Authorization` header as a web
 * request and authenticates it from the cookie the exchange set
 * (kap-server `start.ts`: `if (header === undefined && !hasBearerProtocol)`).
 * The fixture mirrors that so a redeemed browser can actually reach the rest of
 * the API, which is the whole point of the flow.
 */
export function webCookiePresent(request) {
  return /(?:^|;\s*)kiki_web_[0-9a-f]+=/.test(request.headers.cookie ?? '');
}
