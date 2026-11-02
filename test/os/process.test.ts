import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { commandLineQuery, startDetached, stopServer } from '../../src/os/process.js';

/** True while a process with this pid exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('process: the background server', () => {
  let root: string;
  let home: string;
  let serverJs: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'org-launcher-process-')));
    home = join(root, 'home');
    mkdirSync(join(root, 'lib', 'server'), { recursive: true });
    serverJs = join(root, 'lib', 'server', 'main.js');
    // A stand-in server: writes its folder, its home and its pid, then waits to be stopped.
    writeFileSync(
      serverJs,
      [
        "const { writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "writeFileSync(join(process.cwd(), 'seen.json'), JSON.stringify({ cwd: process.cwd(), home: process.env.ORG_LAUNCHER_HOME }));",
        "writeFileSync(join(process.cwd(), 'server.pid'), process.pid + '\\n');",
        'setInterval(() => {}, 1000);',
      ].join('\n')
    );
    writeFileSync(join(root, 'lib', 'server', 'package.json'), '{"type":"commonjs"}');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('startDetached runs the server in the launcher folder and stopServer stops it', async () => {
    const pid = await startDetached(process.execPath, serverJs, home);
    await waitFor(() => existsSync(join(home, 'server.pid')));

    expect(JSON.parse(readFileSync(join(home, 'seen.json'), 'utf8'))).to.deep.equal({ cwd: realpathSync(home), home });
    expect(Number(readFileSync(join(home, 'server.pid'), 'utf8'))).to.equal(pid);

    expect(await stopServer(home)).to.equal(true);
    expect(alive(pid)).to.equal(false);
    expect(existsSync(join(home, 'server.pid'))).to.equal(false);
  });

  it('stopServer says false with no pid file', async () => {
    mkdirSync(home);
    expect(await stopServer(home)).to.equal(false);
  });

  it('stopServer removes a pid file whose process is gone', async () => {
    mkdirSync(home);
    const pid = await startDetached(process.execPath, serverJs, home);
    await waitFor(() => existsSync(join(home, 'server.pid')));
    process.kill(pid, 'SIGKILL');
    await waitFor(() => !alive(pid));

    expect(await stopServer(home)).to.equal(false);
    expect(existsSync(join(home, 'server.pid'))).to.equal(false);
  });

  it('stopServer leaves alone a process that is not the server', async () => {
    mkdirSync(home);
    writeFileSync(join(home, 'server.pid'), `${process.pid}\n`);

    expect(await stopServer(home)).to.equal(false);
    expect(alive(process.pid)).to.equal(true);
    expect(existsSync(join(home, 'server.pid'))).to.equal(false);
  });

  it('stopServer keeps the pid file when the command line cannot be read', async () => {
    mkdirSync(home);
    writeFileSync(join(home, 'server.pid'), `${process.pid}\n`);

    expect(await stopServer(home, async () => null)).to.equal(false);
    expect(alive(process.pid)).to.equal(true);
    expect(existsSync(join(home, 'server.pid'))).to.equal(true);
  });

  it('reads the command line with ps, or with PowerShell on Windows', () => {
    expect(commandLineQuery(42, 'darwin')).to.deep.equal({ cmd: 'ps', args: ['-o', 'command=', '-p', '42'] });
    expect(commandLineQuery(42, 'linux').cmd).to.equal('ps');
    expect(commandLineQuery(42, 'win32')).to.deep.equal({
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=42").CommandLine'],
    });
  });
});
