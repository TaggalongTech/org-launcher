import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { expect } from 'chai';
import { findOrgId, serverHealth, serverState, stateFromError } from '../../src/core/client.js';
import type { OrgLogin } from '../../src/core/orgs.js';

const BLUE = '00DAA0000000001AAA';

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

describe('client: the running server', () => {
  let server: Server | undefined;
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    server.on('connection', (socket: Socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('ours when /api/health says org-launcher', async () => {
    const port = await listen((req, res) => {
      expect(req.headers.host).to.equal(`127.0.0.1:${(server?.address() as AddressInfo).port}`);
      res.end(JSON.stringify({ app: 'org-launcher', version: '1.2.3', port: 1 }));
    });
    expect(await serverState(port)).to.equal('ours');
    expect(await serverHealth(port)).to.deep.equal({ state: 'ours', version: '1.2.3' });
  });

  it('foreign for any other answer, and for no answer within a second', async () => {
    let port = await listen((req, res) => res.end('<html>hello</html>'));
    expect(await serverState(port)).to.equal('foreign');
    await new Promise((resolve) => server?.close(resolve));

    port = await listen(() => {}); // never answers
    const started = Date.now();
    expect(await serverState(port)).to.equal('foreign');
    expect(Date.now() - started).to.be.lessThan(3000);
  });

  it('down when nothing listens', async () => {
    const port = await listen(() => {});
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    expect(await serverState(port)).to.equal('down');
  });

  it('a refused or never-made connection is down; a late answer is foreign', () => {
    const failure = (code: string): Error => Object.assign(new Error('x'), { code });
    expect(stateFromError(failure('ECONNREFUSED'))).to.equal('down');
    expect(stateFromError(failure('ENEVERCONNECTED'))).to.equal('down');
    expect(stateFromError(failure('ETIMEDOUT'))).to.equal('foreign');
    expect(stateFromError(failure('ECONNRESET'))).to.equal('foreign');
  });

  it('finds an org by alias, username, or 15- or 18-character id', () => {
    const logins = [login(BLUE, 'Admin@Blue.example', ['blue'])];
    expect(findOrgId('blue', logins)).to.equal(BLUE);
    expect(findOrgId('admin@blue.example', logins)).to.equal(BLUE);
    expect(findOrgId(BLUE, logins)).to.equal(BLUE);
    expect(findOrgId(BLUE.slice(0, 15), logins)).to.equal(BLUE);
    expect(findOrgId('Blue', logins)).to.equal(null);
    expect(findOrgId('00DAA0000000009', logins)).to.equal(null);
  });
});
