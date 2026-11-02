/**
 * The launcher's local web server: the page and a small JSON API. Only answers requests addressed to
 * localhost or 127.0.0.1 on its own port, and POSTs from no page or from its own page. The log gets
 * the method and path of each request only: never query strings, bodies or login links.
 */
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { StateBusyError } from '../core/state.js';
import { ValidationError } from '../core/validate.js';
import { openUrl } from '../os/browser.js';
import { ActionError, openOrg, removeOrg, runSf, updateOrg, updateSettings, type ActionDeps } from './actions.js';

export type ServerDeps = Omit<ActionDeps, 'open' | 'run'> & {
  /** Opens a link in a browser. Defaults to openUrl. */
  open?: ActionDeps['open'];
  /** Runs the sf CLI. Defaults to running it for real. */
  run?: ActionDeps['run'];
  /** The folder with the page's files. */
  webDir: string;
  version: string;
  /** Gets one line per request (method and path) and per error (its name and code). */
  log?: (line: string) => void;
};

type Body = Record<string, unknown>;

const MAX_BODY = 10_000;

/** Every file the page has. Nothing else is ever read from disk. */
const STATIC: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
  '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json' },
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; default-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

const JSON_TYPE = 'application/json; charset=utf-8';
const FORBIDDEN = "Org Launcher only answers its own page, on this computer.";
const NOT_FOUND = 'Not found.';
const NEEDS_LENGTH = 'Send the request with a Content-Length header.';
const TOO_BIG = 'That request is too big.';
const NOT_JSON = 'The request body must be a JSON object.';
const BAD_REQUEST = "That request couldn't be read.";
const STORE_FAILED = "Couldn't read or save Org Launcher's data. Check that its folder can be read and written.";
const FAILED = 'Something went wrong in Org Launcher. Try again.';

/** An error that becomes a response with this status. */
class HttpError extends Error {
  public constructor(public readonly status: number, message: string, public readonly close = false) {
    super(message);
    this.name = 'HttpError';
  }
}

const errorCode = (error: unknown): string | undefined => {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
};

function send(res: ServerResponse, status: number, body: Buffer | string, type: string, close = false): void {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': data.length,
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(data);
}

const sendJson = (res: ServerResponse, status: number, data: unknown, close = false): void =>
  send(res, status, JSON.stringify(data), JSON_TYPE, close);

/** The status and message for an error. Messages from unknown errors are never sent: they can hold a username or path. */
function describe(error: unknown): { status: number; message: string; close: boolean } {
  if (error instanceof HttpError) return { status: error.status, message: error.message, close: error.close };
  if (error instanceof ActionError) return { status: error.status, message: error.message, close: false };
  if (error instanceof ValidationError) return { status: 400, message: error.message, close: false };
  if (error instanceof StateBusyError) return { status: 503, message: error.message, close: false };
  return { status: 500, message: errorCode(error) ? STORE_FAILED : FAILED, close: false };
}

/** Reads the JSON body. It needs a Content-Length of at most 10 000 bytes; no body reads as {}. */
async function readBody(req: IncomingMessage): Promise<Body> {
  const header = req.headers['content-length'];
  if (header === undefined || !/^\d+$/.test(header) || req.headers['transfer-encoding'] !== undefined) {
    throw new HttpError(411, NEEDS_LENGTH, true);
  }
  if (Number(header) > MAX_BODY) throw new HttpError(413, TOO_BIG, true);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, NOT_JSON);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new HttpError(400, NOT_JSON);
  return data as Body;
}

/** Every tag in use, most used first, then by name. */
function allTags(rows: Array<{ tags: string[] }>): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([tag]) => tag);
}

export function createServer(deps: ServerDeps): Server {
  const log = deps.log ?? ((): void => {});
  const actions: ActionDeps = {
    inventory: deps.inventory,
    store: deps.store,
    loginUrl: deps.loginUrl,
    open: deps.open ?? ((url, target): Promise<void> => openUrl(url, target)),
    run: deps.run ?? runSf,
  };

  const port = (): number => (server.address() as AddressInfo).port;

  /** The Host must name this server; a POST's Origin, when sent, must be this server's page. */
  function allowed(req: IncomingMessage): boolean {
    const hosts = [`localhost:${port()}`, `127.0.0.1:${port()}`];
    if (!hosts.includes(req.headers.host ?? '')) return false;
    const origin = req.headers.origin;
    return req.method !== 'POST' || origin === undefined || hosts.some((host) => origin === `http://${host}`);
  }

  async function get(path: string, res: ServerResponse): Promise<void> {
    if (path === '/api/health') return sendJson(res, 200, { app: 'org-launcher', version: deps.version, port: port() });
    if (path === '/api/orgs') {
      const orgs = deps.inventory.rows();
      const settings = deps.store.settings();
      return sendJson(res, 200, {
        orgs,
        tags: allTags(orgs),
        refresh: deps.inventory.status(),
        settings: { defaultOpen: settings.defaultOpen, tagOpen: settings.tagOpen },
      });
    }
    const page = Object.hasOwn(STATIC, path) ? STATIC[path] : undefined;
    if (!page) return sendJson(res, 404, { error: NOT_FOUND });
    let data: Buffer;
    try {
      data = await readFile(join(deps.webDir, page.file));
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'EISDIR') return sendJson(res, 404, { error: NOT_FOUND });
      throw error;
    }
    send(res, 200, data, page.type);
  }

  const posts: Readonly<Record<string, (body: Body) => unknown>> = {
    '/api/refresh': () => ({ status: deps.inventory.startRefresh() }),
    '/api/open': async (body) => {
      await openOrg(actions, body);
      return { ok: true };
    },
    '/api/remove': async (body) => {
      await removeOrg(actions, body);
      return { ok: true };
    },
    '/api/org': (body) => updateOrg(actions, body),
    '/api/settings': (body) => updateSettings(actions, body),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    log(`${req.method ?? ''} ${path}`);
    if (!allowed(req)) return sendJson(res, 403, { error: FORBIDDEN }, true);
    if (req.method === 'GET') return get(path, res);
    const action = req.method === 'POST' && Object.hasOwn(posts, path) ? posts[path] : undefined;
    if (!action) return sendJson(res, 404, { error: NOT_FOUND });
    const body = await readBody(req);
    sendJson(res, 200, await action(body));
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const { status, message, close } = describe(error);
      if (status === 500) {
        const code = errorCode(error);
        log(`error ${error instanceof Error ? error.name : 'unknown'}${code ? ` ${code}` : ''}`);
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, { error: message }, close);
    });
  });

  // Requests Node can't parse still get the security headers. A bad Content-Length is a 411, like a missing one.
  server.on('clientError', (error: unknown, socket: Socket) => {
    const code = errorCode(error);
    if (code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    const lengthProblem = code === 'HPE_INVALID_CONTENT_LENGTH' || code === 'HPE_UNEXPECTED_CONTENT_LENGTH';
    const status = lengthProblem ? 411 : 400;
    const body = JSON.stringify({ error: lengthProblem ? NEEDS_LENGTH : BAD_REQUEST });
    const headers = Object.entries({
      ...SECURITY_HEADERS,
      'Content-Type': JSON_TYPE,
      'Content-Length': String(Buffer.byteLength(body)),
      Connection: 'close',
    }).map(([name, value]) => `${name}: ${value}\r\n`);
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n${headers.join('')}\r\n${body}`);
  });

  return server;
}
