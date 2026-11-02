import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { LAUNCH_GUARD, launchdPlist, LAUNCHD_LABEL, readPlist } from '../../src/os/launchd.js';
import { loginServiceFor, runCommand, type Run, type RunResult } from '../../src/os/loginService.js';
import { schtasksCommand, TASK_NAME } from '../../src/os/schtasks.js';
import { readUnit, systemdUnit } from '../../src/os/systemd.js';

const ok: RunResult = { code: 0, stdout: '', stderr: '' };
const failed: RunResult = { code: 1, stdout: '', stderr: 'failed' };

/** A fake run that records every command and answers from a table (a missing entry succeeds). */
function fakeRun(answers: Record<string, RunResult> = {}): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const run: Run = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    return Promise.resolve(answers[line] ?? ok);
  };
  return { run, calls };
}

describe('loginService: starting at login', () => {
  let root: string;
  let userHome: string;
  let home: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'org-launcher-login-'));
    userHome = join(root, 'Users', 'Pat Doe');
    home = join(userHome, '.sf', 'org-launcher');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  describe('macOS (launchd)', () => {
    const plistIn = (dir: string): string => join(dir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', SF_ACCESS_TOKEN: '00Dxx!secret-token' };
    let pauses: number[];
    const darwin = (run: Run): ReturnType<typeof loginServiceFor> =>
      loginServiceFor('darwin', run, {
        userHome,
        uid: 501,
        env,
        pause: async (ms) => {
          pauses.push(ms);
        },
      });

    beforeEach(() => {
      pauses = [];
    });

    it('plist runs node and the server through the guard, restarts only after a failure, no secrets', () => {
      const plist = launchdPlist({
        nodePath: '/Users/Pat Doe/.nvm/node',
        serverJs: '/Users/Pat Doe/R&D <x>/lib/server/main.js',
        home: '/Users/Pat Doe/.sf/org-launcher',
        userHome: '/Users/Pat Doe',
        path: '/opt/homebrew/bin:/usr/bin',
      });

      expect(plist).to.include(`<key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>`);
      expect(plist).to.include(
        '<key>ProgramArguments</key>\n  <array>\n    <string>/bin/sh</string>\n    <string>-c</string>\n' +
          '    <string>[ -x &quot;$0&quot; ] &amp;&amp; [ -f &quot;$1&quot; ] || exit 0; exec &quot;$0&quot; &quot;$1&quot;</string>\n' +
          '    <string>/Users/Pat Doe/.nvm/node</string>\n' +
          '    <string>/Users/Pat Doe/R&amp;D &lt;x&gt;/lib/server/main.js</string>\n  </array>'
      );
      expect(plist).to.include('<key>WorkingDirectory</key>\n  <string>/Users/Pat Doe/.sf/org-launcher</string>');
      expect(plist).to.include('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>');
      expect(plist).to.include('<key>HOME</key>\n    <string>/Users/Pat Doe</string>');
      expect(plist).to.include('<key>ORG_LAUNCHER_HOME</key>\n    <string>/Users/Pat Doe/.sf/org-launcher</string>');
      expect(plist).to.include('<key>RunAtLoad</key>\n  <true/>');
      // A clean exit (stopped, port taken, node or server gone) is not restarted; a failure is.
      expect(plist).to.include('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
      expect(plist).to.include('<key>ThrottleInterval</key>\n  <integer>10</integer>');
      expect(plist).to.include('<key>StandardOutPath</key>\n  <string>/Users/Pat Doe/.sf/org-launcher/server.log</string>');
      expect(plist).to.include('<key>StandardErrorPath</key>\n  <string>/Users/Pat Doe/.sf/org-launcher/server.log</string>');
      // Only the three variables the server needs; nothing else from the environment.
      expect(plist.match(/<key>[A-Z_]+<\/key>\n {4}<string>/g)).to.have.length(3);
      expect(plist).not.to.match(/token|secret|password|access/i);
    });

    it('the plist is one launchd reads (macOS)', function () {
      if (process.platform !== 'darwin') this.skip();
      const file = join(root, 'agent.plist');
      writeFileSync(
        file,
        launchdPlist({ nodePath: '/n', serverJs: "/R&D <x> 'q'/main.js", home: '/h', userHome: '/u', path: '/usr/bin' })
      );
      expect(spawnSync('plutil', ['-lint', file]).status).to.equal(0);
    });

    it('the guard runs the server, and exits cleanly when node or the server is gone', function () {
      if (process.platform === 'win32') this.skip();
      const script = join(root, 'server.js');
      writeFileSync(script, 'process.exit(3);');
      const guard = (node: string, js: string): number | null =>
        spawnSync('/bin/sh', ['-c', LAUNCH_GUARD, node, js]).status;

      expect(guard(process.execPath, script)).to.equal(3);
      expect(guard(process.execPath, join(root, 'gone.js'))).to.equal(0);
      expect(guard(join(root, 'no-node'), script)).to.equal(0);
      const notRunnable = join(root, 'node-not-runnable');
      writeFileSync(notRunnable, '');
      chmodSync(notRunnable, 0o644);
      expect(guard(notRunnable, script)).to.equal(0);
    });

    it('register writes the plist and runs the right commands in order', async () => {
      const { run, calls } = fakeRun({ [`launchctl bootout gui/501/${LAUNCHD_LABEL}`]: failed });
      const service = darwin(run);

      await service.register('/usr/local/bin/node', '/plugin/lib/server/main.js', home);

      const file = plistIn(userHome);
      expect(calls).to.deep.equal([`launchctl bootout gui/501/${LAUNCHD_LABEL}`, `launchctl bootstrap gui/501 ${file}`]);
      const plist = readFileSync(file, 'utf8');
      expect(plist).to.include('<string>/usr/local/bin/node</string>\n    <string>/plugin/lib/server/main.js</string>');
      expect(plist).to.include('<string>/opt/homebrew/bin:/usr/bin:/bin</string>');
      expect(plist).not.to.include('secret-token');
      // Windows has no POSIX permission bits; launchd (macOS) is what needs the file not group/world-writable.
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o022).to.equal(0);
      expect(existsSync(home)).to.equal(true);
    });

    it('register tries bootstrap 3 times, then removes the plist and fails', async () => {
      const file = plistIn(userHome);
      const bootstrap = `launchctl bootstrap gui/501 ${file}`;
      const bootout = `launchctl bootout gui/501/${LAUNCHD_LABEL}`;
      const { run, calls } = fakeRun({ [bootstrap]: { code: 5, stdout: '', stderr: 'Input/output error' } });
      const service = darwin(run);

      let error: Error | undefined;
      await service.register('/node', '/main.js', home).catch((e: Error) => (error = e));

      expect(error?.name).to.equal('LoginServiceError');
      expect(error?.message).to.equal("Couldn't start Org Launcher at login: launchctl bootstrap failed (exit 5).");
      expect(calls).to.deep.equal([bootout, bootstrap, bootstrap, bootstrap, bootout]);
      expect(pauses).to.deep.equal([1000, 1000]);
      expect(existsSync(file)).to.equal(false);
      expect(await service.registration()).to.equal(null);
    });

    it('register succeeds when a later bootstrap works', async () => {
      const file = plistIn(userHome);
      const bootstrap = `launchctl bootstrap gui/501 ${file}`;
      let tries = 0;
      const calls: string[] = [];
      const run: Run = (cmd, args) => {
        const line = [cmd, ...args].join(' ');
        calls.push(line);
        if (line === bootstrap) tries += 1;
        return Promise.resolve(line === bootstrap && tries === 1 ? failed : ok);
      };

      await darwin(run).register('/node', '/main.js', home);

      expect(calls.filter((c) => c === bootstrap)).to.have.length(2);
      expect(existsSync(file)).to.equal(true);
    });

    it('unregister removes file and unloads', async () => {
      const { run, calls } = fakeRun();
      const service = darwin(run);
      await service.register('/node', '/main.js', home);
      calls.length = 0;

      await service.unregister();

      expect(calls).to.deep.equal([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
      expect(existsSync(plistIn(userHome))).to.equal(false);
    });

    it('registration reads back node, the server and the folder from the plist', async () => {
      const { run } = fakeRun();
      const service = darwin(run);
      expect(service.readsBack).to.equal(true);
      expect(await service.registration()).to.equal(null);

      await service.register('/Users/Pat Doe/node', '/plugin/lib/server/main.js', home);
      expect(await service.registration()).to.deep.equal({
        nodePath: '/Users/Pat Doe/node',
        serverJs: '/plugin/lib/server/main.js',
        home,
      });
      // Every character the plist escapes reads back as it was.
      const odd = { nodePath: '/Pat & co/node', serverJs: "/plugin <1>/'q'/main.js", home: '/R&D <"x">' };
      expect(readPlist(launchdPlist({ ...odd, userHome: '/u', path: '/bin' }))).to.deep.equal(odd);

      await service.unregister();
      expect(await service.registration()).to.equal(null);
    });

    it('a plist this version did not write reads as unknown paths', () => {
      const old = launchdPlist({ nodePath: '/n', serverJs: '/m.js', home: '/h', userHome: '/u', path: '/bin' }).replace(
        /<string>\/bin\/sh<\/string>\n {4}<string>-c<\/string>\n {4}<string>[^<]*<\/string>\n/,
        ''
      );
      expect(readPlist(old)).to.deep.equal({ nodePath: null, serverJs: null, home: '/h' });
      expect(readPlist('not a plist')).to.deep.equal({ nodePath: null, serverJs: null, home: null });
    });

    it('stop unloads until next login and keeps the file; start loads it again', async () => {
      const file = plistIn(userHome);
      const { run, calls } = fakeRun();
      const service = darwin(run);
      await service.register('/node', '/main.js', home);
      calls.length = 0;

      await service.stop();
      await service.start();

      expect(calls).to.deep.equal([`launchctl bootout gui/501/${LAUNCHD_LABEL}`, `launchctl bootstrap gui/501 ${file}`]);
      expect(existsSync(file)).to.equal(true);
    });

    it('start restarts a service that is still loaded', async () => {
      const file = plistIn(userHome);
      const { run, calls } = fakeRun({ [`launchctl bootstrap gui/501 ${file}`]: failed });
      const service = darwin(run);

      await service.start();

      expect(calls).to.deep.equal([
        `launchctl bootstrap gui/501 ${file}`,
        `launchctl kickstart gui/501/${LAUNCHD_LABEL}`,
      ]);
    });

    it('start fails with a plain message when launchd will not start it', async () => {
      const file = plistIn(userHome);
      const { run } = fakeRun({
        [`launchctl bootstrap gui/501 ${file}`]: failed,
        [`launchctl kickstart gui/501/${LAUNCHD_LABEL}`]: { code: 113, stdout: '', stderr: 'no such service' },
      });

      let error: Error | undefined;
      await darwin(run)
        .start()
        .catch((e: Error) => (error = e));
      expect(error?.name).to.equal('LoginServiceError');
      expect(error?.message).to.equal("Couldn't start Org Launcher: launchctl kickstart failed (exit 113).");
    });

    it('stop of a service that is not loaded is quiet; one that stays loaded is an error', async () => {
      const bootout = `launchctl bootout gui/501/${LAUNCHD_LABEL}`;
      const print = `launchctl print gui/501/${LAUNCHD_LABEL}`;

      const gone = fakeRun({ [bootout]: failed, [print]: failed });
      await darwin(gone.run).stop();
      expect(gone.calls).to.deep.equal([bootout, print]);

      const stuck = fakeRun({ [bootout]: failed });
      let error: Error | undefined;
      await darwin(stuck.run)
        .stop()
        .catch((e: Error) => (error = e));
      expect(error?.message).to.equal("Couldn't stop Org Launcher: launchctl bootout failed (exit 1).");
    });
  });

  describe('Linux (systemd)', () => {
    const unitIn = (dir: string): string => join(dir, '.config', 'systemd', 'user', 'org-launcher.service');

    it('paths with spaces are quoted correctly in systemd and schtasks', () => {
      const unit = systemdUnit({
        nodePath: '/home/pat doe/.nvm/node',
        serverJs: '/home/pat doe/100% "real"\\$HOME/main.js',
        home: '/home/pat doe/.sf/org-launcher',
        path: '/home/pat doe/.nvm/bin:/opt/50% "odd"\\$dir:/usr/bin',
      });
      expect(unit).to.include('ExecStart="/home/pat doe/.nvm/node" "/home/pat doe/100%% \\"real\\"\\\\$$HOME/main.js"\n');
      expect(unit).to.include('WorkingDirectory=/home/pat doe/.sf/org-launcher\n');
      expect(unit).to.include('Environment="ORG_LAUNCHER_HOME=/home/pat doe/.sf/org-launcher"\n');
      // In Environment= a $ is plain; %, \ and " are escaped.
      expect(unit).to.include('Environment="PATH=/home/pat doe/.nvm/bin:/opt/50%% \\"odd\\"\\\\$dir:/usr/bin"\n');
      expect(unit).to.include('Restart=on-failure\n');
      expect(unit).to.include('[Install]\nWantedBy=default.target\n');
      // Not started while node or the server is gone, so it never fails over and over.
      expect(unit).to.include('ConditionPathExists=/home/pat doe/.nvm/node\n');
      expect(unit).to.include('ConditionPathExists=/home/pat doe/100%% "real"\\$HOME/main.js\n');

      expect(schtasksCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Pat Doe\\lib\\server\\main.js')).to.equal(
        '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Pat Doe\\lib\\server\\main.js"'
      );
    });

    it('refuses a path with a line break', () => {
      expect(() => systemdUnit({ nodePath: '/node', serverJs: '/x\nExecStartPre=/evil', home: '/h' })).to.throw(
        "Can't start Org Launcher at login from a path with a line break in it."
      );
    });

    it('register writes the unit and runs the right commands in order', async () => {
      const { run, calls } = fakeRun({ 'systemctl --user stop org-launcher': failed });
      const service = loginServiceFor('linux', run, {
        userHome,
        env: { PATH: '/home/pat/.nvm/versions/node/v22/bin:/usr/bin', SF_ACCESS_TOKEN: '00Dxx!secret-token' },
      });

      await service.register('/usr/bin/node', '/plugin/lib/server/main.js', home);

      expect(calls).to.deep.equal([
        'systemctl --user stop org-launcher',
        'systemctl --user daemon-reload',
        'systemctl --user enable --now org-launcher',
      ]);
      const unit = readFileSync(unitIn(userHome), 'utf8');
      expect(unit).to.include('ExecStart="/usr/bin/node" "/plugin/lib/server/main.js"');
      expect(unit).to.include('Environment="PATH=/home/pat/.nvm/versions/node/v22/bin:/usr/bin"\n');
      expect(unit).not.to.include('secret-token');
    });

    it('leaves PATH to systemd when there is none to copy', async () => {
      const { run } = fakeRun();
      await loginServiceFor('linux', run, { userHome, env: {} }).register('/n', '/m', home);
      expect(readFileSync(unitIn(userHome), 'utf8')).not.to.include('PATH=');
    });

    it('uses XDG_CONFIG_HOME when it is set', async () => {
      const configHome = join(root, 'config');
      const { run } = fakeRun();
      await loginServiceFor('linux', run, { userHome, env: { XDG_CONFIG_HOME: configHome } }).register('/n', '/m', home);
      expect(existsSync(join(configHome, 'systemd', 'user', 'org-launcher.service'))).to.equal(true);
    });

    it('unregister removes file and unloads', async () => {
      const { run, calls } = fakeRun();
      const service = loginServiceFor('linux', run, { userHome, env: {} });
      await service.register('/n', '/m', home);
      calls.length = 0;

      await service.unregister();

      expect(calls).to.deep.equal(['systemctl --user disable --now org-launcher', 'systemctl --user daemon-reload']);
      expect(existsSync(unitIn(userHome))).to.equal(false);
    });

    it('registration reads back node, the server and the folder from the unit', async () => {
      const service = loginServiceFor('linux', fakeRun().run, { userHome, env: {} });
      expect(service.readsBack).to.equal(true);
      expect(await service.registration()).to.equal(null);

      await service.register('/home/pat doe/.nvm/node', '/home/pat doe/main.js', home);
      expect(await service.registration()).to.deep.equal({
        nodePath: '/home/pat doe/.nvm/node',
        serverJs: '/home/pat doe/main.js',
        home,
      });
      // Every character the unit escapes reads back as it was.
      const odd = { nodePath: '/50% $$ "n"/node', serverJs: '/home/100% "real"\\$HOME/main.js', home: '/h/50% "x"\\$y' };
      expect(readUnit(systemdUnit(odd))).to.deep.equal(odd);

      writeFileSync(unitIn(userHome), '');
      expect(await service.registration()).to.deep.equal({ nodePath: null, serverJs: null, home: null });
      expect(readUnit('[Service]\nExecStart=/usr/bin/node /m.js\n')).to.deep.equal({ nodePath: null, serverJs: null, home: null });
    });

    it('stop and start use systemctl --user', async () => {
      const { run, calls } = fakeRun();
      const service = loginServiceFor('linux', run, { userHome, env: {} });
      await service.stop();
      await service.start();
      expect(calls).to.deep.equal(['systemctl --user stop org-launcher', 'systemctl --user start org-launcher']);
    });

    it('register fails when systemd refuses the service, and leaves no unit behind', async () => {
      const { run, calls } = fakeRun({ 'systemctl --user enable --now org-launcher': failed });
      let error: Error | undefined;
      await loginServiceFor('linux', run, { userHome, env: {} })
        .register('/n', '/m', home)
        .catch((e: Error) => (error = e));
      expect(error?.message).to.equal("Couldn't start Org Launcher at login: systemctl enable failed (exit 1).");
      expect(calls.slice(-2)).to.deep.equal(['systemctl --user disable --now org-launcher', 'systemctl --user daemon-reload']);
      expect(existsSync(unitIn(userHome))).to.equal(false);
    });
  });

  describe('Windows (Task Scheduler)', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const serverJs = 'C:\\Users\\Pat Doe\\AppData\\Local\\sf\\lib\\server\\main.js';

    it('register runs the right commands in order', async () => {
      const { run, calls } = fakeRun({ [`schtasks /End /TN ${TASK_NAME}`]: failed });
      const service = loginServiceFor('win32', run);

      await service.register(node, serverJs, home);

      expect(calls).to.deep.equal([
        `schtasks /End /TN ${TASK_NAME}`,
        `schtasks /Create /TN ${TASK_NAME} /SC ONLOGON /RL LIMITED /F /TR "${node}" "${serverJs}"`,
        `schtasks /Run /TN ${TASK_NAME}`,
      ]);
    });

    it('passes the task name and command as single arguments', async () => {
      const seen: string[][] = [];
      const run: Run = (cmd, args) => {
        seen.push(args);
        return Promise.resolve(ok);
      };
      await loginServiceFor('win32', run).register(node, serverJs, home);
      expect(seen[1]).to.deep.equal([
        '/Create',
        '/TN',
        'Org Launcher',
        '/SC',
        'ONLOGON',
        '/RL',
        'LIMITED',
        '/F',
        '/TR',
        `"${node}" "${serverJs}"`,
      ]);
    });

    it('unregister removes the task and stops it', async () => {
      const { run, calls } = fakeRun();
      await loginServiceFor('win32', run).unregister();
      expect(calls).to.deep.equal([`schtasks /End /TN ${TASK_NAME}`, `schtasks /Delete /TN ${TASK_NAME} /F`]);
    });

    it('registration says whether the task exists, but not what it runs', async () => {
      const query = `schtasks /Query /TN ${TASK_NAME}`;
      const service = loginServiceFor('win32', fakeRun().run);
      expect(service.readsBack).to.equal(false);
      expect(await service.registration()).to.deep.equal({ nodePath: null, serverJs: null, home: null });
      expect(await loginServiceFor('win32', fakeRun({ [query]: failed }).run).registration()).to.equal(null);
    });

    it('register deletes the task when it will not run', async () => {
      const { run, calls } = fakeRun({ [`schtasks /Run /TN ${TASK_NAME}`]: failed });
      let error: Error | undefined;
      await loginServiceFor('win32', run)
        .register(node, serverJs, home)
        .catch((e: Error) => (error = e));
      expect(error?.message).to.equal("Couldn't start Org Launcher at login: schtasks /Run failed (exit 1).");
      expect(calls.at(-1)).to.equal(`schtasks /Delete /TN ${TASK_NAME} /F`);
    });

    it('stop ends the task and start runs it', async () => {
      const { run, calls } = fakeRun();
      const service = loginServiceFor('win32', run);
      await service.stop();
      await service.start();
      expect(calls).to.deep.equal([`schtasks /End /TN ${TASK_NAME}`, `schtasks /Run /TN ${TASK_NAME}`]);
    });
  });

  it('runCommand resolves with the exit code, and -1 for a program that is not there', async () => {
    expect((await runCommand(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)'])).code).to.equal(3);
    expect(await runCommand(process.execPath, ['-e', 'process.stdout.write("hi")'])).to.deep.equal({
      code: 0,
      stdout: 'hi',
      stderr: '',
    });
    expect((await runCommand(join(root, 'no-such-program'), [])).code).to.equal(-1);
  });

  it('says plainly when the platform has no login service', () => {
    expect(() => loginServiceFor('aix', fakeRun().run)).to.throw('Starting at login works on macOS, Linux and Windows.');
  });
});
