import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { rotateLog } from '../../src/server/main.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('server main: the background process', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'org-launcher-main-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('rotateLog moves a log over the limit to server.log.1, keeping one old log', () => {
    const log = join(home, 'server.log');
    writeFileSync(`${log}.1`, 'oldest');
    writeFileSync(log, 'x'.repeat(11));

    rotateLog(log, 10);

    expect(existsSync(log)).to.equal(false);
    expect(readFileSync(`${log}.1`, 'utf8')).to.equal('x'.repeat(11));
  });

  it('rotateLog leaves a small log, and no log, alone', () => {
    const log = join(home, 'server.log');
    rotateLog(log, 10);
    expect(existsSync(`${log}.1`)).to.equal(false);

    writeFileSync(log, 'x'.repeat(10));
    rotateLog(log, 10);
    expect(readFileSync(log, 'utf8')).to.equal('x'.repeat(10));
    expect(existsSync(`${log}.1`)).to.equal(false);
  });

  it('exits cleanly when another program has the port, so the login service does not restart it', async () => {
    const other: Server = createServer((req, res) => res.end());
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const port = (other.address() as AddressInfo).port;
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ port }));
    try {
      const child = spawn(
        process.execPath,
        ['--loader', 'ts-node/esm', '--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'server', 'main.ts')],
        { cwd: ROOT, env: { ...process.env, ORG_LAUNCHER_HOME: home }, stdio: 'ignore' }
      );
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));

      expect(code).to.equal(0);
      expect(readFileSync(join(home, 'server.log'), 'utf8')).to.include(`port ${port} is in use`);
      expect(existsSync(join(home, 'server.pid'))).to.equal(false);
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  });
});
