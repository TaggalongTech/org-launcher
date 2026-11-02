import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import type { OrgQuery } from '../../src/core/checks.js';
import { Inventory, type OrgRow } from '../../src/core/inventory.js';
import type { AuthSource, OrgLogin } from '../../src/core/orgs.js';
import { StateStore, type OpenTarget } from '../../src/core/state.js';
import { createServer } from '../../src/server/http.js';

const BLUE = '00DAA0000000001AAA';
const GREEN = '00DAA0000000002AAA';
const MISSING = '00DAA0000000009AAA';
const SECRET_URL = 'https://blue.example.my.salesforce.com/secur/frontdoor.jsp?otp=SECRET-OTP';
const GONE = "That org isn't logged in to the sf CLI any more. Refresh the page.";

type Answer = Awaited<ReturnType<OrgQuery>>;
type Reply = { status: number; headers: IncomingHttpHeaders; text: string; json: () => unknown };

function login(orgId: string, username: string, aliases: string[] = []): OrgLogin {
  return {
    orgId,
    username,
    aliases,
    isScratch: false,
    isDevHub: false,
    isSandbox: false,
    instanceUrl: 'https://example.my.salesforce.com',
    isExpired: false,
  };
}

const LOGINS = [
  login(BLUE, 'admin@blue.example', ['blue']),
  login(BLUE, 'dev@blue.example'),
  login(GREEN, 'admin@green.example', ['green']),
];

function fakeAuth(logins: OrgLogin[]): AuthSource {
  return { listLogins: async () => logins.map((l) => ({ ...l, aliases: [...l.aliases] })), defaultUsername: async () => null };
}

/** Waits until the inventory's refresh has listed the logins and started checking. */
async function listed(inventory: Inventory): Promise<void> {
  while (inventory.status().running && inventory.status().total === 0) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function checkSecurityHeaders(headers: IncomingHttpHeaders): void {
  expect(headers['x-frame-options']).to.equal('DENY');
  expect(headers['content-security-policy']).to.equal("frame-ancestors 'none'; default-src 'self'");
  expect(headers['x-content-type-options']).to.equal('nosniff');
  expect(headers['cache-control']).to.equal('no-store');
}

describe('http: local JSON API and page', () => {
  let dir: string;
  let web: string;
  let store: StateStore;
  let inventory: Inventory;
  let server: Server;
  let port: number;
  let finishChecks: () => void;
  let logLines: string[];
  let loginUrlCalls: string[];
  let opened: Array<{ url: string; target: OpenTarget | null }>;
  let runs: Array<{ cmd: string; args: string[] }>;

  /** Sends one request. Host defaults to 127.0.0.1:<port>; pass headers to override. */
  function send(
    method: string,
    path: string,
    options: { body?: string; headers?: Record<string, string | number>; chunked?: boolean } = {}
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = { Host: `127.0.0.1:${port}`, ...options.headers };
      if (options.body !== undefined && !options.chunked && headers['Content-Length'] === undefined) {
        headers['Content-Length'] = Buffer.byteLength(options.body);
      }
      const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) as unknown });
        });
      });
      req.on('error', reject);
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
    send('POST', path, { body: JSON.stringify(body), headers });

  /** Sends raw bytes and returns the raw response. */
  function sendRaw(raw: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(raw));
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'org-launcher-http-'));
    web = join(dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Org Launcher</title>');
    writeFileSync(join(web, 'app.js'), 'console.log("hi");');
    store = new StateStore(dir);
    const pending = new Promise<Answer>((resolve) => {
      finishChecks = (): void => resolve({ orgType: 'Developer Edition', isSandbox: false, packages: [], unpackagedApex: 0 });
    });
    inventory = new Inventory({ auth: fakeAuth(LOGINS), query: () => pending, store, cacheDir: dir, timeoutMs: 60_000 });
    inventory.startRefresh();
    await listed(inventory);

    logLines = [];
    loginUrlCalls = [];
    opened = [];
    runs = [];
    server = createServer({
      inventory,
      store,
      loginUrl: async (username) => {
        loginUrlCalls.push(username);
        return SECRET_URL;
      },
      open: async (url, target) => {
        opened.push({ url, target });
      },
      run: async (cmd, args) => {
        runs.push({ cmd, args });
      },
      webDir: web,
      version: '9.9.9',
      log: (line) => logLines.push(line),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    finishChecks();
    while (inventory.status().running) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it('403 for Host evil.com', async () => {
    const reply = await send('GET', '/api/health', { headers: { Host: 'evil.com' } });
    expect(reply.status).to.equal(403);
    expect(reply.json()).to.have.property('error');
    const otherPort = await send('GET', '/api/health', { headers: { Host: `localhost:${port + 1}` } });
    expect(otherPort.status).to.equal(403);
    expect((await send('GET', '/api/health', { headers: { Host: `localhost:${port}` } })).status).to.equal(200);
  });

  it('403 for POST with Origin http://evil.com', async () => {
    const reply = await post('/api/refresh', {}, { Origin: 'http://evil.com' });
    expect(reply.status).to.equal(403);
    expect((await post('/api/refresh', {}, { Origin: 'null' })).status).to.equal(403);
    expect((await post('/api/refresh', {}, { Origin: `http://localhost:${port}` })).status).to.equal(200);
    expect((await post('/api/refresh', {}, { Origin: `http://127.0.0.1:${port}` })).status).to.equal(200);
  });

  it('POST without Origin allowed', async () => {
    const reply = await post('/api/refresh', {});
    expect(reply.status).to.equal(200);
    expect(reply.json()).to.deep.equal({ status: 'already running' });
  });

  it('security headers on every response', async () => {
    const replies = [
      await send('GET', '/api/health'),
      await send('GET', '/'),
      await send('GET', '/nope'),
      await send('GET', '/api/health', { headers: { Host: 'evil.com' } }),
      await post('/api/open', { id: 'not-an-id' }),
      await post('/api/open', { id: MISSING }),
      await send('POST', '/api/refresh', { body: 'x'.repeat(10_001) }),
      await send('POST', '/api/refresh', { body: '{}', chunked: true }),
    ];
    expect(replies.map((r) => r.status)).to.deep.equal([200, 200, 404, 403, 400, 404, 413, 411]);
    for (const reply of replies) checkSecurityHeaders(reply.headers);
  });

  it('GET /api/orgs answers while refresh is stuck', async () => {
    store.update(BLUE, { tags: ['work', 'demo'] });
    store.update(GREEN, { tags: ['demo'] });
    store.updateSettings({ defaultOpen: { browser: 'edge' }, tagOpen: { work: { browser: 'chrome' } } });
    const reply = await send('GET', '/api/orgs');
    expect(reply.status).to.equal(200);
    const body = reply.json() as {
      orgs: OrgRow[];
      tags: string[];
      refresh: { running: boolean; total: number };
      settings: unknown;
    };
    expect(body.orgs.map((o) => o.id).sort()).to.deep.equal([BLUE, GREEN]);
    expect(body.tags).to.deep.equal(['demo', 'work']);
    expect(body.refresh).to.include({ running: true, total: 2 });
    expect(body.settings).to.deep.equal({ defaultOpen: { browser: 'edge' }, tagOpen: { work: { browser: 'chrome' } } });
  });

  it('health identifies the app', async () => {
    const reply = await send('GET', '/api/health');
    expect(reply.headers['content-type']).to.equal('application/json; charset=utf-8');
    expect(reply.json()).to.deep.equal({ app: 'org-launcher', version: '9.9.9', port });
  });

  it('open uses resolved target and never returns the url', async () => {
    store.update(BLUE, { tags: ['demo', 'work'] });
    store.updateSettings({ defaultOpen: { browser: 'edge' }, tagOpen: { work: { browser: 'chrome', profile: 'Profile 3' } } });
    const reply = await post('/api/open', { id: BLUE });
    expect(reply.status).to.equal(200);
    expect(reply.text).to.not.include('SECRET');
    expect(reply.text).to.not.include('frontdoor');
    expect(loginUrlCalls).to.deep.equal(['admin@blue.example']);
    expect(opened).to.deep.equal([{ url: SECRET_URL, target: { browser: 'chrome', profile: 'Profile 3' } }]);

    const other = await post('/api/open', { id: BLUE, username: 'dev@blue.example' });
    expect(other.status).to.equal(200);
    expect(loginUrlCalls).to.deep.equal(['admin@blue.example', 'dev@blue.example']);
    expect(logLines.join('\n')).to.not.include('SECRET');
    expect(logLines.join('\n')).to.not.include('@');
  });

  it('open never returns the url when opening fails', async () => {
    const failing = createServer({
      inventory,
      store,
      loginUrl: async () => SECRET_URL,
      open: async () => {
        throw new Error(`could not open ${SECRET_URL}`);
      },
      run: async () => {},
      webDir: web,
      version: '9.9.9',
      log: (line) => logLines.push(line),
    });
    await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
    const before = port;
    port = (failing.address() as AddressInfo).port;
    try {
      const reply = await post('/api/open', { id: BLUE });
      expect(reply.status).to.equal(500);
      expect(reply.text).to.not.include('SECRET');
      expect(logLines.join('\n')).to.not.include('SECRET');
    } finally {
      failing.closeAllConnections();
      await new Promise<void>((resolve) => failing.close(() => resolve()));
      port = before;
    }
  });

  it('open with unknown username 400', async () => {
    const reply = await post('/api/open', { id: BLUE, username: 'admin@green.example' });
    expect(reply.status).to.equal(400);
    expect(reply.json()).to.have.property('error');
    expect(loginUrlCalls).to.deep.equal([]);
    expect(opened).to.deep.equal([]);
  });

  it('unknown org id 404, malformed id 400', async () => {
    const missing = await post('/api/open', { id: MISSING });
    expect(missing.status).to.equal(404);
    expect(missing.json()).to.deep.equal({ error: GONE });
    expect((await post('/api/org', { id: MISSING, note: 'x' })).status).to.equal(404);
    expect((await post('/api/remove', { id: MISSING })).status).to.equal(404);
    expect((await post('/api/open', { id: '00DAA0000000001' })).status).to.equal(400);
    expect((await post('/api/open', {})).status).to.equal(400);
    expect(runs).to.deep.equal([]);
  });

  it('remove logs out every login of the org', async () => {
    const reply = await post('/api/remove', { id: BLUE });
    expect(reply.status).to.equal(200);
    expect(runs).to.deep.equal([
      { cmd: 'sf', args: ['org', 'logout', '--target-org', 'admin@blue.example', '--no-prompt'] },
      { cmd: 'sf', args: ['org', 'logout', '--target-org', 'dev@blue.example', '--no-prompt'] },
    ]);
  });

  it('remove during a running refresh drops the row at once; a second remove says it is gone', async () => {
    expect(inventory.status().running).to.equal(true);
    expect((await post('/api/remove', { id: BLUE })).status).to.equal(200);
    expect(inventory.rows().map((r) => r.id)).not.to.include(BLUE);

    const again = await post('/api/remove', { id: BLUE });
    expect(again.status).to.equal(404);
    expect(again.json()).to.deep.equal({ error: GONE });
    expect(runs).to.have.length(2);
  });

  it('org update validates tags and returns row', async () => {
    const bad = await post('/api/org', { id: BLUE, tags: ['Bad Tag!'] });
    expect(bad.status).to.equal(400);
    expect(bad.json()).to.deep.equal({
      error: 'Tags are lowercase letters, numbers, dot, dash or underscore, up to 32 characters.',
    });
    expect(store.get(BLUE).tags).to.deep.equal([]);

    const reply = await post('/api/org', { id: BLUE, tags: ['Work', 'q4'], note: ' hi ', hidden: true });
    expect(reply.status).to.equal(200);
    const row = reply.json() as OrgRow;
    expect(row.id).to.equal(BLUE);
    expect(row).to.include({ note: 'hi', hidden: true });
    expect(row.tags).to.deep.equal(['work', 'q4']);

    const changed = (await post('/api/org', { id: BLUE, addTags: ['demo'], removeTags: ['q4'] })).json() as OrgRow;
    expect(changed.tags).to.deep.equal(['work', 'demo']);

    const main = (await post('/api/org', { id: BLUE, mainLogin: 'dev@blue.example' })).json() as OrgRow;
    expect(main.logins.find((l) => l.main)?.username).to.equal('dev@blue.example');
    expect((await post('/api/org', { id: BLUE, mainLogin: 'admin@green.example' })).status).to.equal(400);
    expect((await post('/api/org', { id: BLUE, open: { browser: 'safari' } })).status).to.equal(400);
  });

  it('settings: changes the page settings only', async () => {
    const savedPort = store.settings().port;
    const reply = await post('/api/settings', { defaultOpen: { browser: 'firefox', profile: 'work' }, port: 4343 });
    expect(reply.status).to.equal(200);
    expect(reply.json()).to.deep.equal({ defaultOpen: { browser: 'firefox', profile: 'work' }, tagOpen: {} });
    // The port changes only with sf launcher start --port.
    expect(store.settings().port).to.equal(savedPort);
    await post('/api/settings', { projects: ['/elsewhere'] });
    expect(store.settings().projects).to.deep.equal([]);
  });

  it('413 and 411 cases', async () => {
    const big = await send('POST', '/api/org', { body: JSON.stringify({ id: BLUE, note: 'x'.repeat(10_001) }) });
    expect(big.status).to.equal(413);
    const chunked = await send('POST', '/api/refresh', { body: '{}', chunked: true });
    expect(chunked.status).to.equal(411);
    const noLength = await sendRaw(`POST /api/refresh HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(noLength).to.match(/^HTTP\/1\.1 411 /);
    const badLength = await sendRaw(`POST /api/refresh HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: abc\r\n\r\n{}`);
    expect(badLength).to.match(/^HTTP\/1\.1 411 /);
    expect(badLength).to.include('X-Frame-Options: DENY');
    expect((await send('POST', '/api/refresh', { body: 'not json' })).status).to.equal(400);
  });

  it('404 for /../package.json', async () => {
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/web/app.js', '/app.css', '/index.html/']) {
      // eslint-disable-next-line no-await-in-loop
      const reply = await send('GET', path);
      expect(reply.status, path).to.equal(404);
    }
    const raw = await sendRaw(`GET /../package.json HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(raw).to.match(/^HTTP\/1\.1 404 /);
  });

  it('serves the page from the fixed map', async () => {
    const page = await send('GET', '/');
    expect(page.status).to.equal(200);
    expect(page.headers['content-type']).to.equal('text/html; charset=utf-8');
    expect(page.text).to.include('Org Launcher');
    const js = await send('GET', '/app.js');
    expect(js.headers['content-type']).to.equal('text/javascript; charset=utf-8');
  });

  it('logs method and path only', async () => {
    await send('GET', '/api/health?token=abc');
    await post('/api/org', { id: BLUE, note: 'private note' });
    expect(logLines).to.include('GET /api/health');
    expect(logLines).to.include('POST /api/org');
    expect(logLines.join('\n')).to.not.include('abc');
    expect(logLines.join('\n')).to.not.include('private');
  });

  it('a store read error gives a 500 JSON error and the server keeps running', async function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
    store.update(BLUE, { note: 'x' });
    chmodSync(join(dir, 'state.json'), 0o000);
    const reply = await send('GET', '/api/orgs');
    expect(reply.status).to.equal(500);
    expect(reply.headers['content-type']).to.equal('application/json; charset=utf-8');
    expect(reply.json()).to.have.property('error').that.is.a('string');
    checkSecurityHeaders(reply.headers);
    chmodSync(join(dir, 'state.json'), 0o600);
    expect((await send('GET', '/api/health')).status).to.equal(200);
  });
});
