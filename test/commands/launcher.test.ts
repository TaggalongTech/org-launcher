import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import Dock from '../../src/commands/launcher/dock.js';
import Launcher from '../../src/commands/launcher/index.js';
import Note from '../../src/commands/launcher/note.js';
import Start from '../../src/commands/launcher/start.js';
import Status from '../../src/commands/launcher/status.js';
import Stop from '../../src/commands/launcher/stop.js';
import Tag from '../../src/commands/launcher/tag.js';
import Uninstall from '../../src/commands/launcher/uninstall.js';
import { resetCommandDeps, serverScript, setCommandDeps, stableNodePath, type DockModule } from '../../src/commandSupport.js';
import type { OrgLogin } from '../../src/core/orgs.js';
import { StateStore, type OpenTarget } from '../../src/core/state.js';
import { LoginServiceError, type LoginService, type Registration } from '../../src/os/loginService.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER_JS = join(ROOT, 'lib', 'server', 'main.js');
const BLUE = '00DAA0000000001AAA';
const GREEN = '00DAA0000000002AAA';

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

const LOGINS = [login(BLUE, 'admin@blue.example', ['blue']), login(GREEN, 'admin@green.example', ['green'])];

type Reply = { status: number; body: unknown };
type Handler = (req: IncomingMessage, body: string) => Reply;
type Outcome<T> = { result?: T; error?: Error & { exitCode?: number }; out: string; err: string };

/** Starts a local HTTP server on port (0: any free port) that answers with handler. */
async function fakeServer(handler: Handler, port = 0): Promise<Server> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const reply = handler(req, Buffer.concat(chunks).toString('utf8'));
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

const portOf = (server: Server): number => (server.address() as AddressInfo).port;

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const server = await fakeServer(() => ({ status: 200, body: {} }));
  const port = portOf(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Answers /api/health like Org Launcher, and passes other requests to rest. */
const ours =
  (rest: Handler = () => ({ status: 404, body: { error: 'Not found.' } })): Handler =>
  (req, body) =>
    req.url === '/api/health' ? { status: 200, body: { app: 'org-launcher', version: '9.9.9', port: 0 } } : rest(req, body);

/** Runs a command with its output captured, and clears the exit code it leaves behind. */
async function run<T>(command: () => Promise<T>): Promise<Outcome<T>> {
  const outcome: Outcome<T> = { out: '', err: '' };
  const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    outcome.out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    outcome.err += String(chunk);
    return true;
  };
  try {
    outcome.result = await command();
  } catch (error) {
    outcome.error = error as Error & { exitCode?: number };
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
    process.exitCode = undefined;
  }
  return outcome;
}

describe('commands: sf launcher', () => {
  let home: string;
  let store: StateStore;
  let servers: Server[];
  let calls: string[];
  let questions: string[];
  let answer: boolean;
  let tty: boolean;
  /** What the fake login service runs; null when it isn't registered. */
  let registration: Registration | null;
  /** This folder's login service, as the fake registers it. */
  const ourService = (): Registration => ({ nodePath: '/fake/node', serverJs: SERVER_JS, home });
  let opened: Array<{ url: string; target: OpenTarget | null; appMode: boolean }>;
  let savedHome: string | undefined;

  let service: LoginService;
  const makeService = (): LoginService => ({
    register: async (nodePath, serverJs, dir) => {
      calls.push(`register ${nodePath} ${serverJs} ${dir}`);
      registration = { nodePath, serverJs, home: dir };
    },
    unregister: async () => {
      calls.push('unregister');
      registration = null;
    },
    registration: async () => registration,
    readsBack: true,
    start: async () => {
      calls.push('service start');
    },
    stop: async () => {
      calls.push('service stop');
    },
  });

  let dockBuilt: boolean;
  const dock: DockModule = {
    buildDockApp: async (dir, opts) => {
      calls.push(`buildDockApp ${dir} ${opts.port}`);
      dockBuilt = true;
      return '/Applications/Org Launcher.app';
    },
    removeDockApp: async () => {
      calls.push('removeDockApp');
      dockBuilt = false;
    },
    hasDockApp: () => dockBuilt,
  };

  /** Saves the port the commands look at. */
  function usePort(port: number): void {
    store.updateSettings({ port });
  }

  async function serve(handler: Handler, port = 0): Promise<number> {
    const server = await fakeServer(handler, port);
    servers.push(server);
    return portOf(server);
  }

  function useDeps(platform: NodeJS.Platform = 'darwin'): void {
    setCommandDeps({
      platform,
      cwd: () => home,
      interactive: () => tty,
      ask: async (question) => {
        questions.push(question);
        return answer;
      },
      logins: async () => LOGINS,
      startDetached: async (nodePath, serverJs, dir) => {
        calls.push(`startDetached ${nodePath} ${serverJs} ${dir}`);
        await serve(ours(), store.settings().port);
        return 4321;
      },
      stopServer: async (dir) => {
        calls.push(`stopServer ${dir}`);
        return false;
      },
      loginService: () => service,
      dock: async () => dock,
      open: async (url, target, appMode) => {
        opened.push({ url, target, appMode });
      },
      nodePath: '/fake/node',
    });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'org-launcher-commands-'));
    savedHome = process.env.ORG_LAUNCHER_HOME;
    process.env.ORG_LAUNCHER_HOME = home;
    store = new StateStore(home);
    servers = [];
    calls = [];
    questions = [];
    answer = true;
    tty = false;
    registration = null;
    dockBuilt = false;
    opened = [];
    service = makeService();
    useDeps();
  });

  afterEach(async () => {
    resetCommandDeps();
    if (savedHome === undefined) delete process.env.ORG_LAUNCHER_HOME;
    else process.env.ORG_LAUNCHER_HOME = savedHome;
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    rmSync(home, { recursive: true, force: true });
  });

  describe('tag and note', () => {
    it('tag adds via server when ours', async () => {
      const posts: unknown[] = [];
      const port = await serve(
        ours((req, body) => {
          posts.push({ method: req.method, url: req.url, host: req.headers.host, body: JSON.parse(body) as unknown });
          return { status: 200, body: { id: BLUE, tags: ['demo'], note: 'from server' } };
        })
      );
      usePort(port);

      const { result, error, out } = await run(() => Tag.run(['blue', 'demo'], ROOT));

      expect(error).to.equal(undefined);
      expect(posts).to.deep.equal([
        { method: 'POST', url: '/api/org', host: `127.0.0.1:${port}`, body: { id: BLUE, addTags: ['demo'] } },
      ]);
      expect(existsSync(join(home, 'state.json'))).to.equal(false);
      expect(result).to.deep.equal({ org: 'blue', orgId: BLUE, tags: ['demo'], note: 'from server' });
      expect(out).to.include('Tags: demo');
      expect(out).to.include('Note: from server');
    });

    it('tag writes file directly when down', async () => {
      usePort(await freePort());
      store.addTags(BLUE, ['old', 'keep']);

      const { result, error } = await run(() => Tag.run(['admin@blue.example', 'demo', '--remove', 'old'], ROOT));

      expect(error).to.equal(undefined);
      expect(store.get(BLUE).tags).to.deep.equal(['keep', 'demo']);
      expect(result).to.deep.include({ orgId: BLUE, tags: ['keep', 'demo'] });
    });

    it('tag --set replaces every tag', async () => {
      usePort(await freePort());
      store.addTags(BLUE, ['old']);

      const { error } = await run(() => Tag.run(['blue', '--set', 'a', '--set', 'b'], ROOT));

      expect(error).to.equal(undefined);
      expect(store.get(BLUE).tags).to.deep.equal(['a', 'b']);
    });

    it('a 15-character org id saves under the 18-character id', async () => {
      usePort(await freePort());

      const { error } = await run(() => Tag.run([BLUE.slice(0, 15), 'demo'], ROOT));

      expect(error).to.equal(undefined);
      expect(Object.keys(store.all())).to.deep.equal([BLUE]);
    });

    it('tag refuses when port is foreign', async () => {
      const port = await serve(() => ({ status: 200, body: { app: 'something-else' } }));
      usePort(port);

      const { error, err } = await run(() => Tag.run(['blue', 'demo'], ROOT));

      expect(error?.exitCode).to.equal(1);
      const message = `Port ${port} is in use by another program. Set a different port with sf launcher start --port <n>.`;
      expect(error?.message).to.equal(message);
      expect(err.trim()).to.equal(message);
      expect(existsSync(join(home, 'state.json'))).to.equal(false);
    });

    it('note replaces', async () => {
      usePort(await freePort());
      store.update(GREEN, { note: 'old note', tags: ['x'] });

      const { result, error, out } = await run(() => Note.run(['green', 'new note'], ROOT));

      expect(error).to.equal(undefined);
      expect(store.get(GREEN)).to.deep.include({ note: 'new note', tags: ['x'] });
      expect(result).to.deep.equal({ org: 'green', orgId: GREEN, tags: ['x'], note: 'new note' });
      expect(out).to.include('Note: new note');
    });

    it('an empty note clears it', async () => {
      usePort(await freePort());
      store.update(GREEN, { note: 'old note' });

      const { error, out } = await run(() => Note.run(['green', ''], ROOT));

      expect(error).to.equal(undefined);
      expect(store.get(GREEN).note).to.equal('');
      expect(out).to.include('Note: none');
    });

    it('unknown org exits 1 with message', async () => {
      usePort(await freePort());

      const tag = await run(() => Tag.run(['nope', 'demo'], ROOT));
      const note = await run(() => Note.run(['nope', 'text'], ROOT));

      for (const { error, err } of [tag, note]) {
        expect(error?.exitCode).to.equal(1);
        expect(error?.message).to.equal('No org "nope" in your sf CLI logins.');
        expect(err.trim()).to.equal('No org "nope" in your sf CLI logins.');
      }
      expect(existsSync(join(home, 'state.json'))).to.equal(false);
    });
  });

  describe('the server script', () => {
    it("is this plugin's built server, found from the plugin's own files", () => {
      expect(serverScript()).to.equal(SERVER_JS);
      expect(existsSync(serverScript()), 'run npm run build first').to.equal(true);
    });

    // In the sf CLI a command's config is the CLI's, not this plugin's: the server path must not follow it.
    describe('when the CLI root is not this plugin', () => {
      let cliRoot: string;
      beforeEach(() => {
        cliRoot = mkdtempSync(join(tmpdir(), 'org-launcher-cli-root-'));
        writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({ name: 'fake-cli', version: '1.0.0', oclif: {} }));
      });
      afterEach(() => rmSync(cliRoot, { recursive: true, force: true }));

      it('sf launcher starts the plugin server', async () => {
        usePort(await freePort());

        const { error } = await run(() => Launcher.run([], cliRoot));

        expect(error).to.equal(undefined);
        expect(calls).to.deep.equal([`startDetached /fake/node ${SERVER_JS} ${home}`]);
      });

      it('sf launcher start starts the plugin server', async () => {
        usePort(await freePort());

        const { error } = await run(() => Start.run([], cliRoot));

        expect(error).to.equal(undefined);
        expect(calls).to.deep.equal([`startDetached /fake/node ${SERVER_JS} ${home}`]);
      });
    });
  });

  describe('sf launcher', () => {
    it('starts the server detached when down and opens the page as an app window', async () => {
      usePort(await freePort());
      store.updateSettings({ defaultOpen: { browser: 'chrome', profile: 'Profile 3' } });
      const port = store.settings().port;

      const { error, result } = await run(() => Launcher.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal([`startDetached /fake/node ${join(ROOT, 'lib', 'server', 'main.js')} ${home}`]);
      expect(opened).to.deep.equal([
        { url: `http://localhost:${port}`, target: { browser: 'chrome', profile: 'Profile 3' }, appMode: true },
      ]);
      expect(result).to.deep.equal({ url: `http://localhost:${port}`, started: true });
    });

    it('starts through the login service when it is registered', async () => {
      const port = await freePort();
      usePort(port);
      registration = ourService();
      service.start = async (): Promise<void> => {
        calls.push('service start');
        await serve(ours(), port);
      };

      const { error } = await run(() => Launcher.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal(['service start']);
    });

    it('keeps going when the project folder cannot be remembered', async () => {
      usePort(await serve(ours()));
      setCommandDeps({
        cwd: () => {
          throw new Error('no cwd');
        },
      });

      const { error } = await run(() => Launcher.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(opened).to.have.length(1);
    });

    it('first run asks twice on darwin, once elsewhere, never again', async () => {
      tty = true;
      usePort(await serve(ours()));

      await run(() => Launcher.run([], ROOT));
      expect(questions).to.deep.equal(['Keep Org Launcher running at login? (Y/n)', 'Add Org Launcher to the Dock? (Y/n)']);
      expect(calls).to.include(`register /fake/node ${join(ROOT, 'lib', 'server', 'main.js')} ${home}`);
      expect(calls).to.include(`buildDockApp ${home} ${store.settings().port}`);
      expect(store.settings().asked).to.deep.equal({ atLogin: true, dock: true });

      await run(() => Launcher.run([], ROOT));
      expect(questions).to.have.length(2);

      store.updateSettings({ asked: { atLogin: false, dock: false } });
      questions = [];
      answer = false;
      calls = [];
      useDeps('linux');
      await run(() => Launcher.run([], ROOT));
      expect(questions).to.deep.equal(['Keep Org Launcher running at login? (Y/n)']);
      expect(calls).to.deep.equal([]);
      expect(store.settings().asked).to.deep.equal({ atLogin: true, dock: false });
    });

    it('a yes to start at login stops the detached server before registering', async () => {
      tty = true;
      usePort(await serve(ours()));
      store.updateSettings({ asked: { atLogin: false, dock: true } });

      await run(() => Launcher.run([], ROOT));

      expect(calls).to.deep.equal([
        `stopServer ${home}`,
        `register /fake/node ${join(ROOT, 'lib', 'server', 'main.js')} ${home}`,
      ]);
    });

    it('non-TTY first run asks nothing and registers nothing', async () => {
      tty = false;
      usePort(await freePort());

      const { error } = await run(() => Launcher.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(questions).to.deep.equal([]);
      expect(calls.filter((c) => !c.startsWith('startDetached'))).to.deep.equal([]);
      expect(registration).to.equal(null);
      expect(dockBuilt).to.equal(false);
      expect(store.settings().asked).to.deep.equal({ atLogin: false, dock: false });
    });

    it('refuses a port another program uses', async () => {
      const port = await serve(() => ({ status: 404, body: {} }));
      usePort(port);

      const { error } = await run(() => Launcher.run([], ROOT));

      expect(error?.exitCode).to.equal(1);
      expect(error?.message).to.equal(
        `Port ${port} is in use by another program. Set a different port with sf launcher start --port <n>.`
      );
      expect(calls).to.deep.equal([]);
      expect(opened).to.deep.equal([]);
    });
  });

  describe('start, stop and status', () => {
    it('start --at-login registers without asking', async () => {
      tty = true;
      const port = await freePort();
      usePort(port);
      const register = service.register;
      service.register = async (...args): Promise<void> => {
        await register(...args);
        await serve(ours(), port);
      };

      const { error } = await run(() => Start.run(['--at-login'], ROOT));

      expect(error).to.equal(undefined);
      expect(questions).to.deep.equal([]);
      expect(calls).to.deep.equal([
        `stopServer ${home}`,
        `register /fake/node ${join(ROOT, 'lib', 'server', 'main.js')} ${home}`,
      ]);
      expect(store.settings().asked.atLogin).to.equal(true);
    });

    it('start --port saves the port and starts there', async () => {
      usePort(await freePort());
      const port = await freePort();

      const { error, out } = await run(() => Start.run(['--port', String(port)], ROOT));

      expect(error).to.equal(undefined);
      expect(store.settings().port).to.equal(port);
      expect(out).to.include(`Running at http://localhost:${port}`);
    });

    it('start --port refuses a taken port and changes nothing', async () => {
      const old = await serve(ours());
      usePort(old);
      const taken = await serve(() => ({ status: 404, body: {} }));

      const { error, err } = await run(() => Start.run(['--port', String(taken)], ROOT));

      const message = `Port ${taken} is in use by another program. Set a different port with sf launcher start --port <n>.`;
      expect(error?.exitCode).to.equal(1);
      expect(err.trim()).to.equal(message);
      expect(store.settings().port).to.equal(old);
      expect(calls).to.deep.equal([]);
    });

    it('start says the port message when another program has it', async () => {
      const port = await serve(() => ({ status: 200, body: { app: 'other' } }));
      usePort(port);

      const { error } = await run(() => Start.run([], ROOT));

      expect(error?.exitCode).to.equal(1);
      expect(error?.message).to.equal(
        `Port ${port} is in use by another program. Set a different port with sf launcher start --port <n>.`
      );
      expect(calls).to.deep.equal([]);
    });

    it('stop unloads the login service until next login and says so', async () => {
      registration = ourService();
      usePort(await serve(ours()));

      const { error, out } = await run(() => Stop.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal(['service stop', `stopServer ${home}`]);
      expect(out).to.include('starts again at your next login');
    });

    it('status --json shape', async () => {
      const port = await serve(ours());
      usePort(port);
      registration = ourService();

      const { result, error } = await run(() => Status.run(['--json'], ROOT));

      expect(error).to.equal(undefined);
      expect(result).to.deep.equal({
        state: 'running',
        port,
        url: `http://localhost:${port}`,
        version: '9.9.9',
        startsAtLogin: true,
        dockApp: false,
      });
    });

    it('status prints running, not running and the port message', async () => {
      const port = await serve(ours());
      usePort(port);
      const running = await run(() => Status.run([], ROOT));
      expect(running.out).to.include(`Running at http://localhost:${port} (version 9.9.9)`);
      expect(running.out).to.include('Starts at login: no');
      expect(running.out).to.include('Dock app: no');

      usePort(await freePort());
      useDeps('linux');
      const down = await run(() => Status.run([], ROOT));
      expect(down.out).to.include('Not running');
      expect(down.out).not.to.include('Dock app');

      const foreign = await serve(() => ({ status: 404, body: {} }));
      usePort(foreign);
      const taken = await run(() => Status.run(['--json'], ROOT));
      expect(taken.result).to.deep.include({ state: 'port-in-use', version: null, dockApp: null });
      const text = await run(() => Status.run([], ROOT));
      expect(text.out).to.include(
        `Port ${foreign} is in use by another program. Set a different port with sf launcher start --port <n>.`
      );
    });
  });

  describe('dock', () => {
    it('dock builds the app with the saved port and browser', async () => {
      store.updateSettings({ port: 4343, defaultOpen: { browser: 'chrome', profile: 'Profile 2' } });
      let options: unknown;
      const buildDockApp = dock.buildDockApp;
      setCommandDeps({
        dock: async () => ({
          ...dock,
          buildDockApp: async (dir, opts) => {
            options = opts;
            return buildDockApp(dir, opts);
          },
        }),
      });

      const { result, error, out } = await run(() => Dock.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal([`buildDockApp ${home} 4343`]);
      expect(options).to.deep.equal({ port: 4343, defaultOpen: { browser: 'chrome', profile: 'Profile 2' } });
      expect(result).to.deep.equal({ app: '/Applications/Org Launcher.app', removed: false });
      expect(out.trim()).to.equal('Added Org Launcher to the Dock.');
    });

    it('dock --remove unpins and deletes the app', async () => {
      dockBuilt = true;

      const { result, error, out } = await run(() => Dock.run(['--remove'], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal(['removeDockApp']);
      expect(result).to.deep.equal({ app: null, removed: true });
      expect(out.trim()).to.equal('Removed Org Launcher from the Dock.');
    });

    it('dock says it is for macOS elsewhere', async () => {
      useDeps('linux');

      const { error, err } = await run(() => Dock.run([], ROOT));

      expect(error?.exitCode).to.equal(1);
      expect(err.trim()).to.equal('The Dock app is for macOS.');
      expect(calls).to.deep.equal([]);
    });

    it('dock prints a failure as a plain line', async () => {
      setCommandDeps({
        dock: async () => ({
          ...dock,
          buildDockApp: () => Promise.reject(new Error("Couldn't make the Dock icon: iconutil failed (exit 1).")),
        }),
      });

      const { error, err } = await run(() => Dock.run([], ROOT));

      expect(error?.exitCode).to.equal(1);
      expect(err.trim()).to.equal("Couldn't make the Dock icon: iconutil failed (exit 1).");
    });
  });

  describe('uninstall', () => {
    it('uninstall keeps state without --purge', async () => {
      registration = ourService();
      dockBuilt = true;
      store.addTags(BLUE, ['keep']);

      const { error, out } = await run(() => Uninstall.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal(['unregister', `stopServer ${home}`, 'removeDockApp']);
      expect(store.get(BLUE).tags).to.deep.equal(['keep']);
      expect(out).to.include('sf plugins uninstall @taggalongtech/org-launcher');
    });

    it('uninstall --purge deletes saved data', async () => {
      store.addTags(BLUE, ['gone']);

      const { error } = await run(() => Uninstall.run(['--purge'], ROOT));

      expect(error).to.equal(undefined);
      expect(existsSync(join(home, 'state.json'))).to.equal(false);
      expect(calls).to.deep.equal([`stopServer ${home}`]);
    });

    it('uninstall on Linux leaves the Dock alone', async () => {
      useDeps('linux');
      dockBuilt = true;

      await run(() => Uninstall.run([], ROOT));

      expect(calls).to.deep.equal([`stopServer ${home}`]);
    });
  });

  describe('the login service', () => {
    const register = `register /fake/node ${SERVER_JS}`;
    const failRegister = (): void => {
      service.register = async (nodePath, serverJs, dir): Promise<void> => {
        calls.push(`register ${nodePath} ${serverJs} ${dir}`);
        throw new LoginServiceError("Couldn't start Org Launcher at login: launchctl bootstrap failed (exit 5).");
      };
    };

    it('stableNodePath uses the sf CLI client current link when it is there', () => {
      const versioned = '/Users/pat/.local/share/sf/client/2.155.7-a445bce/bin/node';
      const current = '/Users/pat/.local/share/sf/client/current/bin/node';
      expect(stableNodePath(versioned, (path) => path === current)).to.equal(current);
      expect(stableNodePath(versioned, () => false)).to.equal(versioned);
      expect(stableNodePath(current, () => true)).to.equal(current);
      expect(stableNodePath('/usr/local/bin/node', () => true)).to.equal('/usr/local/bin/node');
      expect(stableNodePath('/opt/homebrew/Cellar/node/24.1.0/bin/node', () => true)).to.equal(
        '/opt/homebrew/Cellar/node/24.1.0/bin/node'
      );
      const windows = 'C:\\Users\\Pat\\AppData\\Local\\sf\\client\\2.155.7-a445bce\\bin\\node.exe';
      const windowsCurrent = 'C:\\Users\\Pat\\AppData\\Local\\sf\\client\\current\\bin\\node.exe';
      expect(stableNodePath(windows, (path) => path === windowsCurrent)).to.equal(windowsCurrent);
    });

    it('sf launcher registers again, quietly, when the service runs another node', async () => {
      const port = await freePort();
      usePort(port);
      registration = { ...ourService(), nodePath: '/old/client/2.100.0-abc/bin/node' };
      service.register = async (nodePath, serverJs, dir): Promise<void> => {
        calls.push(`register ${nodePath} ${serverJs} ${dir}`);
        registration = { nodePath, serverJs, home: dir };
        await serve(ours(), port);
      };

      const { error, out, err } = await run(() => Launcher.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal([`stopServer ${home}`, `${register} ${home}`]);
      expect(registration).to.deep.equal(ourService());
      expect(out).not.to.include('login');
      expect(err).to.equal('');
    });

    it('start registers again when the service runs another server script, or a plist it cannot read', async () => {
      for (const stale of [{ serverJs: '/old/plugin/lib/server/main.js' }, { nodePath: null, serverJs: null }]) {
        const port = await freePort(); // eslint-disable-line no-await-in-loop
        usePort(port);
        calls = [];
        registration = { ...ourService(), ...stale };
        service.register = async (nodePath, serverJs, dir): Promise<void> => {
          calls.push(`register ${nodePath} ${serverJs} ${dir}`);
          registration = { nodePath, serverJs, home: dir };
          await serve(ours(), port);
        };

        const { error } = await run(() => Start.run([], ROOT)); // eslint-disable-line no-await-in-loop

        expect(error).to.equal(undefined);
        expect(calls).to.deep.equal([`stopServer ${home}`, `${register} ${home}`]);
      }
    });

    it('a service that runs the current node and server is left as it is', async () => {
      const port = await freePort();
      usePort(port);
      registration = ourService();
      service.start = async (): Promise<void> => {
        calls.push('service start');
        await serve(ours(), port);
      };

      await run(() => Launcher.run([], ROOT));

      expect(calls).to.deep.equal(['service start']);
    });

    it('a failed register at first run starts the server again on its own and warns', async () => {
      tty = true;
      usePort(await serve(ours()));
      store.updateSettings({ asked: { atLogin: false, dock: true } });
      failRegister();
      setCommandDeps({
        // The fake page server above stands in for the one started again.
        startDetached: async (nodePath, serverJs, dir) => {
          calls.push(`startDetached ${nodePath} ${serverJs} ${dir}`);
          return 4321;
        },
      });

      const { error, err } = await run(() => Launcher.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal([`stopServer ${home}`, `${register} ${home}`, `startDetached /fake/node ${SERVER_JS} ${home}`]);
      expect(err).to.include("Couldn't set Org Launcher to start at login. Try again with sf launcher start --at-login.");
      expect(store.settings().asked.atLogin).to.equal(true);
    });

    it('a failed start --at-login starts the server on its own and says why in one plain line', async () => {
      usePort(await freePort());
      failRegister();

      const { error, err } = await run(() => Start.run(['--at-login'], ROOT));

      expect(error?.exitCode).to.equal(1);
      expect(err.trim()).to.equal("Couldn't start Org Launcher at login: launchctl bootstrap failed (exit 5).");
      expect(calls).to.deep.equal([`stopServer ${home}`, `${register} ${home}`, `startDetached /fake/node ${SERVER_JS} ${home}`]);
    });

    it('a service that will not start falls back to starting the server on its own', async () => {
      usePort(await freePort());
      registration = ourService();
      service.start = async (): Promise<void> => {
        calls.push('service start');
        throw new LoginServiceError("Couldn't start Org Launcher: launchctl kickstart failed (exit 113).");
      };

      const { error, result } = await run(() => Launcher.run([], ROOT));

      expect(error).to.equal(undefined);
      expect(calls).to.deep.equal(['service start', `startDetached /fake/node ${SERVER_JS} ${home}`]);
      expect(result).to.deep.include({ started: true });
    });

    describe('registered for another ORG_LAUNCHER_HOME', () => {
      const elsewhere = '/Users/pat/.sf/org-launcher';
      beforeEach(() => {
        registration = { nodePath: '/fake/node', serverJs: SERVER_JS, home: elsewhere };
      });

      it('sf launcher starts its own server, asks nothing about login and never touches the service', async () => {
        tty = true;
        usePort(await freePort());
        store.updateSettings({ asked: { atLogin: false, dock: true } });

        const { error } = await run(() => Launcher.run([], ROOT));

        expect(error).to.equal(undefined);
        expect(calls).to.deep.equal([`startDetached /fake/node ${SERVER_JS} ${home}`]);
        expect(questions).to.deep.equal([]);
        expect(registration?.home).to.equal(elsewhere);
      });

      it('status, stop and uninstall leave it alone', async () => {
        usePort(await serve(ours()));

        const status = await run(() => Status.run(['--json'], ROOT));
        expect(status.result).to.deep.include({ startsAtLogin: false });
        const stop = await run(() => Stop.run([], ROOT));
        expect(stop.result).to.deep.equal({ stopped: false, startsAtLogin: false });
        await run(() => Uninstall.run([], ROOT));

        expect(calls.filter((c) => !c.startsWith('stopServer') && c !== 'removeDockApp')).to.deep.equal([]);
        expect(registration?.home).to.equal(elsewhere);
      });

      it('start --at-login refuses before changing anything', async () => {
        usePort(await freePort());

        const { error, err } = await run(() => Start.run(['--at-login'], ROOT));

        expect(error?.exitCode).to.equal(1);
        expect(err.trim()).to.equal(
          `Org Launcher already starts at login for ${elsewhere}. Run sf launcher uninstall with ORG_LAUNCHER_HOME set to that folder first.`
        );
        expect(calls).to.deep.equal([]);
        expect(store.settings().asked.atLogin).to.equal(false);
      });

      it('on Windows, where the task cannot say its folder, the task counts as ours', async () => {
        usePort(await serve(ours()));
        service = { ...makeService(), readsBack: false };
        registration = { nodePath: null, serverJs: null, home: null };

        const status = await run(() => Status.run(['--json'], ROOT));

        expect(status.result).to.deep.include({ startsAtLogin: true });
        expect(calls).to.deep.equal([]); // and it's never registered again
      });
    });
  });
});
