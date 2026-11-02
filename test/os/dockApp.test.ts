import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from 'chai';
import {
  BUNDLE_ID,
  buildDockApp,
  dockAppPath,
  hasDockApp,
  iconName,
  infoPlist,
  launchScript,
  removeDockApp,
  type LaunchTools,
} from '../../src/os/dockApp.js';
import { runCommand, type Run, type RunResult } from '../../src/os/loginService.js';

const ICON_SVG = fileURLToPath(new URL('../../assets/icon.svg', import.meta.url));
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const failed: RunResult = { code: 1, stdout: '', stderr: 'failed' };

/** The value after flag in args. */
const after = (args: string[], flag: string): string => args[args.indexOf(flag) + 1];

/**
 * A fake Mac: records every command and answers like the real tools. The icon tools write the files
 * they're asked for; `defaults`/`plutil` answer from `dock`, the list of file URLs pinned in the Dock.
 */
function fakeMac(cacheDir: string, dock: string[] = []): { run: Run; calls: string[]; dock: string[] } {
  const calls: string[] = [];
  const run: Run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'qlmanage') writeFileSync(join(after(args, '-o'), `${basename(args.at(-1)!)}.png`), 'png');
    if (cmd === 'sips' || cmd === 'iconutil') writeFileSync(after(args, cmd === 'sips' ? '--out' : '-o'), 'image');
    if (cmd === 'getconf') return Promise.resolve(ok(`${cacheDir}/\n`));
    if (cmd === 'defaults' && args[0] === 'export') writeFileSync(args[2], 'plist');
    if (cmd === 'plutil' && args[0] === '-extract') {
      if (args[1] === 'persistent-apps') return Promise.resolve(ok(`${dock.length}\n`));
      const url = dock[Number(args[1].split('.')[1])];
      return Promise.resolve(url ? ok(`${url}\n`) : failed);
    }
    if (cmd === 'plutil' && args[0] === '-remove') dock.splice(Number(args[1].split('.')[1]), 1);
    return Promise.resolve(ok());
  };
  return { run, calls, dock };
}

/** The error a promise rejects with; undefined when it resolves. */
const failure = (promise: Promise<unknown>): Promise<Error | undefined> =>
  promise.then(
    () => undefined,
    (error: Error) => error
  );

const isDockCommand = (line: string): boolean => /^(defaults|killall|getconf)\b/.test(line);

describe('dockApp: the Mac Dock app', () => {
  // The Dock app is macOS only; the `dock` command's own tests cover the other platforms.
  before(function () {
    if (process.platform !== 'darwin') this.skip();
  });

  let root: string;
  let appDir: string;
  let home: string;
  let cacheDir: string;
  let iconCache: string;
  let svg: string;
  let app: string;
  let appUrl: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'org-launcher-dock-'));
    appDir = join(root, 'Pat Doe', 'Applications');
    home = join(root, 'Pat Doe', '.sf', 'org-launcher');
    cacheDir = join(root, 'cache');
    iconCache = join(cacheDir, 'com.apple.dock.iconcache');
    mkdirSync(home, { recursive: true });
    mkdirSync(cacheDir);
    writeFileSync(iconCache, 'cached icons');
    svg = join(root, 'icon.svg');
    writeFileSync(svg, readFileSync(ICON_SVG));
    app = dockAppPath(appDir);
    appUrl = `${pathToFileURL(app).href}/`;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const build = (run: Run, pin = true): Promise<string> =>
    buildDockApp(home, { port: 4242, defaultOpen: null, appDir, pin, run, iconSvg: svg });

  it('Info.plist has name Org Launcher and icon name with hash', async () => {
    const hash = createHash('md5').update(readFileSync(ICON_SVG)).digest('hex').slice(0, 8);
    expect(iconName(readFileSync(ICON_SVG))).to.equal(`AppIcon-${hash}`);

    const plist = infoPlist(`AppIcon-${hash}`);
    expect(plist).to.include('<key>CFBundleName</key><string>Org Launcher</string>');
    expect(plist).to.include('<key>CFBundleDisplayName</key><string>Org Launcher</string>');
    expect(plist).to.include(`<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>`);
    expect(BUNDLE_ID).to.equal('com.taggalong.org-launcher.app');
    expect(plist).to.include(`<key>CFBundleIconFile</key><string>AppIcon-${hash}</string>`);
    expect(plist).to.include('<key>CFBundleExecutable</key><string>org-launcher</string>');

    const { run } = fakeMac(cacheDir);
    expect(await build(run, false)).to.equal(join(appDir, 'Org Launcher.app'));
    expect(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')).to.equal(plist);
    expect(existsSync(join(app, 'Contents', 'Resources', `AppIcon-${hash}.icns`))).to.equal(true);
    expect(hasDockApp(appDir)).to.equal(true);
  });

  it('renders the icon with qlmanage at 1024, every size with sips, then iconutil', async () => {
    const { run, calls } = fakeMac(cacheDir);
    await build(run, false);

    const icon = iconName(readFileSync(svg));
    expect(calls[0]).to.match(/^qlmanage -t -s 1024 -o \S+ /);
    expect(calls[0].endsWith(svg)).to.equal(true);
    const sizes = calls.filter((c) => c.startsWith('sips')).map((c) => /icon_(\d+x\d+(@2x)?)\.png$/.exec(c)?.[1]);
    expect(sizes).to.deep.equal([
      '16x16',
      '16x16@2x',
      '32x32',
      '32x32@2x',
      '128x128',
      '128x128@2x',
      '256x256',
      '256x256@2x',
      '512x512',
      '512x512@2x',
    ]);
    expect(calls.find((c) => c.startsWith('sips -z 1024 1024'))).to.match(/icon_512x512@2x\.png$/);
    expect(calls.find((c) => c.startsWith('iconutil'))).to.match(/^iconutil -c icns \S+\/AppIcon\.iconset -o \S+\.icns$/);
    expect(existsSync(join(app, 'Contents', 'Resources', `${icon}.icns`))).to.equal(true);
    expect(calls.filter(isDockCommand)).to.deep.equal([]);
  });

  it('launch script uses --app with chromium default, plain open otherwise', () => {
    const script = launchScript(join(home, 'settings.json'));
    expect(script.startsWith('#!/bin/sh\n')).to.equal(true);
    expect(script).to.include(`SETTINGS='${home}/settings.json'`);
    expect(script).to.include('PORT=4242');
    expect(script).to.include("chrome) APP='Google Chrome' ;;");
    expect(script).to.include("edge) APP='Microsoft Edge' ;;");
    expect(script).to.include("brave) APP='Brave Browser' ;;");
    expect(script).not.to.include('Firefox');
    expect(script).to.include("OPEN='/usr/bin/open'");
    expect(script).to.include("CURL='/usr/bin/curl'");
    expect(script).to.include("LAUNCHCTL='/bin/launchctl'");
    expect(script).to.include("OSASCRIPT='/usr/bin/osascript'");
    expect(script).to.include(`AGENT='${join(homedir(), 'Library', 'LaunchAgents', 'com.taggalong.org-launcher.plist')}'`);
    expect(script).to.include('"$CURL" -s -m 1 "http://127.0.0.1:$PORT/api/health"');
    expect(script).to.include('"$LAUNCHCTL" kickstart "gui/$(/usr/bin/id -u)/com.taggalong.org-launcher"');
    // It never starts node itself.
    expect(script).not.to.match(/\bnode\b/);
    expect(script).to.include('*) exec "$OPEN" "$URL" ;;');
    expect(script).to.include('exec "$OPEN" -na "$APP" --args "--profile-directory=$PROFILE" "--app=$URL"');
    expect(script).to.include('exec "$OPEN" -na "$APP" --args "--app=$URL"');
  });

  it('shell-quotes the settings path', () => {
    expect(launchScript("/Users/Pat O'Neil/.sf/org-launcher/settings.json")).to.include(
      "SETTINGS='/Users/Pat O'\\''Neil/.sf/org-launcher/settings.json'"
    );
    expect(() => launchScript('/tmp/a\0b')).to.throw();
  });

  describe('running the launch script (macOS)', () => {
    let opened: string;
    let tools: LaunchTools;
    /** While this file is there, the fake curl answers like Org Launcher's /api/health. */
    let up: string;
    /** While this file is there, the fake launchctl's kickstart brings the server up. */
    let kickWorks: string;

    /** A fake program that writes its arguments, one per line, to <root>/<name>.txt, then runs body. */
    function fake(name: string, body = ''): string {
      const file = join(root, `fake-${name}`);
      writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${join(root, `${name}.txt`)}'\n${body}\n`);
      chmodSync(file, 0o755);
      return file;
    }

    /** The arguments a fake program was run with; [] when it wasn't run. */
    const argsOf = (name: string): string[] =>
      existsSync(join(root, `${name}.txt`)) ? readFileSync(join(root, `${name}.txt`), 'utf8').trimEnd().split('\n') : [];

    beforeEach(() => {
      opened = join(root, 'open.txt');
      up = join(root, 'up');
      kickWorks = join(root, 'kick-works');
      writeFileSync(up, '');
      tools = {
        open: fake('open'),
        curl: fake('curl', `[ -f '${up}' ] || exit 7\nprintf '{"app":"org-launcher","version":"9.9.9","port":4343}'`),
        launchctl: fake('launchctl', `[ -f '${kickWorks}' ] && : > '${up}'\nexit 0`),
        osascript: fake('osascript'),
        sleep: '/usr/bin/true',
        agentPlist: join(root, 'agent.plist'),
      };
    });

    /** Writes settings.json, runs the script and returns the arguments it gave open. */
    function launch(settings: unknown, settingsFile = join(home, 'settings.json')): string[] {
      if (settings !== undefined) writeFileSync(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings));
      const script = join(root, 'launch.sh');
      writeFileSync(script, launchScript(settingsFile, tools));
      rmSync(opened, { force: true });
      execFileSync('/bin/sh', [script]);
      return argsOf('open');
    }

    it('checks Org Launcher answers on the port before opening', () => {
      expect(launch({ port: 4343, defaultOpen: null })).to.deep.equal(['http://localhost:4343']);
      expect(argsOf('curl')).to.deep.equal(['-s', '-m', '1', 'http://127.0.0.1:4343/api/health']);
      expect(argsOf('launchctl')).to.deep.equal([]);
      expect(argsOf('osascript')).to.deep.equal([]);
    });

    it('asks launchd to start the login service when the server is down, then opens', () => {
      rmSync(up);
      writeFileSync(tools.agentPlist, 'plist');
      writeFileSync(kickWorks, '');

      expect(launch({ port: 4343, defaultOpen: null })).to.deep.equal(['http://localhost:4343']);
      const uid = execFileSync('/usr/bin/id', ['-u'], { encoding: 'utf8' }).trim();
      expect(argsOf('launchctl')).to.deep.equal(['kickstart', `gui/${uid}/com.taggalong.org-launcher`]);
      expect(argsOf('osascript')).to.deep.equal([]);
    });

    it('says how to start it, and opens nothing, when it stays down', () => {
      rmSync(up);
      writeFileSync(tools.agentPlist, 'plist');

      expect(launch({ port: 4343, defaultOpen: null })).to.deep.equal([]);
      expect(argsOf('launchctl')).to.have.length(2);
      expect(argsOf('curl').filter((a) => a === '-s')).to.have.length(12); // the first check, 10 waits, the last
      expect(argsOf('osascript').slice(-2)).to.deep.equal([
        "Org Launcher isn't running",
        'Run sf launcher in a terminal to start it.',
      ]);
    });

    it('without a login service it says how to start it at once, never touching launchd', () => {
      rmSync(up);

      expect(launch({ port: 4343, defaultOpen: null })).to.deep.equal([]);
      expect(argsOf('launchctl')).to.deep.equal([]);
      expect(argsOf('curl').filter((a) => a === '-s')).to.have.length(2);
      expect(argsOf('osascript')).to.include("Org Launcher isn't running");
    });

    it('a server on the port that is not Org Launcher counts as down', () => {
      tools.curl = fake('foreign-curl', "printf '{\"app\":\"something-else\"}'");

      expect(launch({ port: 4343, defaultOpen: null })).to.deep.equal([]);
      expect(argsOf('osascript')).to.include("Org Launcher isn't running");
    });

    it('opens the page as its own window in a Chromium browser and profile', () => {
      const args = launch({ port: 4343, defaultOpen: { browser: 'chrome', profile: 'Profile 3' } });
      expect(args).to.deep.equal(['-na', 'Google Chrome', '--args', '--profile-directory=Profile 3', '--app=http://localhost:4343']);
      expect(launch({ port: 4343, defaultOpen: { browser: 'brave' } })).to.deep.equal([
        '-na',
        'Brave Browser',
        '--args',
        '--app=http://localhost:4343',
      ]);
    });

    it('opens the default browser with no Chromium default', () => {
      expect(launch({ port: 4343, defaultOpen: null })).to.deep.equal(['http://localhost:4343']);
      expect(launch({ port: 4343, defaultOpen: { browser: 'firefox', profile: 'work' } })).to.deep.equal([
        'http://localhost:4343',
      ]);
    });

    it('uses the defaults when settings.json is missing or broken, like the server', () => {
      expect(launch(undefined)).to.deep.equal(['http://localhost:4242']);
      expect(launch('{not json')).to.deep.equal(['http://localhost:4242']);
    });

    it('never passes on a port or profile the server would refuse', () => {
      expect(launch({ port: '4343; touch pwned', defaultOpen: null })).to.deep.equal(['http://localhost:4242']);
      expect(launch({ port: 80, defaultOpen: null })).to.deep.equal(['http://localhost:4242']);
      expect(launch({ port: 4343, defaultOpen: { browser: 'edge', profile: 'Profile 1" --x="$(touch pwned)' } })).to.deep.equal([
        '-na',
        'Microsoft Edge',
        '--args',
        '--app=http://localhost:4343',
      ]);
      expect(launch({ port: 4343, defaultOpen: { browser: '$(touch pwned)' } })).to.deep.equal(['http://localhost:4343']);
      expect(existsSync(join(dirname(root), 'pwned'))).to.equal(false);
      expect(existsSync('pwned')).to.equal(false);
    });

    it('reads a settings path with a quote and spaces in it', () => {
      const odd = join(root, "Pat O'Neil $(x)");
      mkdirSync(odd);
      expect(launch({ port: 4444, defaultOpen: null }, join(odd, 'settings.json'))).to.deep.equal(['http://localhost:4444']);
    });
  });

  describe('the Dock', () => {
    it('pins a new app and restarts the Dock', async () => {
      const mac = fakeMac(cacheDir, ['file:///System/Applications/Mail.app/']);
      await build(mac.run);

      const write = mac.calls.find((c) => c.startsWith('defaults write'));
      expect(write).to.equal(
        'defaults write com.apple.dock persistent-apps -array-add ' +
          '<dict><key>tile-data</key><dict><key>file-data</key><dict>' +
          `<key>_CFURLString</key><string>${appUrl}</string>` +
          '<key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>'
      );
      expect(appUrl).to.include('Pat%20Doe/Applications/Org%20Launcher.app/');
      expect(mac.calls.at(-1)).to.equal('killall Dock');
    });

    it('already pinned → no defaults write', async () => {
      const mac = fakeMac(cacheDir, ['file:///System/Applications/Mail.app/', appUrl]);
      await build(mac.run);
      expect(mac.calls.filter((c) => c.startsWith('defaults write'))).to.deep.equal([]);

      // A pin the Dock saved without percent-encoding counts too.
      const plain = fakeMac(cacheDir, [`file://${app}/`]);
      await build(plain.run);
      expect(plain.calls.filter((c) => c.startsWith('defaults write'))).to.deep.equal([]);
    });

    it('cache cleared only when icon name changed', async () => {
      const first = fakeMac(cacheDir, [appUrl]);
      await build(first.run);
      // A first build has no earlier icon, so the Dock's copy of any old one is cleared.
      expect(existsSync(iconCache)).to.equal(false);
      expect(first.calls.at(-1)).to.equal('killall Dock');

      writeFileSync(iconCache, 'cached icons');
      const same = fakeMac(cacheDir, [appUrl]);
      await build(same.run);
      expect(existsSync(iconCache)).to.equal(true);
      expect(same.calls.filter((c) => c.startsWith('killall') || c.startsWith('getconf'))).to.deep.equal([]);

      writeFileSync(svg, readFileSync(ICON_SVG, 'utf8').replace('#0D4651', '#123456'));
      const changed = fakeMac(cacheDir, [appUrl]);
      await build(changed.run);
      expect(existsSync(iconCache)).to.equal(false);
      expect(changed.calls.filter(isDockCommand).slice(-2)).to.deep.equal(['getconf DARWIN_USER_CACHE_DIR', 'killall Dock']);
      expect(readdirIcons()).to.deep.equal([`${iconName(readFileSync(svg))}.icns`]);
    });

    it('pin: false changes nothing in the Dock', async () => {
      const mac = fakeMac(cacheDir);
      await build(mac.run, false);
      expect(mac.calls.filter(isDockCommand)).to.deep.equal([]);
      expect(existsSync(iconCache)).to.equal(true);
    });

    it('a failed icon render keeps the earlier app', async () => {
      const mac = fakeMac(cacheDir);
      await build(mac.run, false);
      const broken: Run = (cmd, args) => (cmd === 'iconutil' ? Promise.resolve(failed) : mac.run(cmd, args));

      let error: Error | undefined;
      await build(broken, false).catch((e: Error) => {
        error = e;
      });

      expect(error?.message).to.equal("Couldn't make the Dock icon: iconutil failed (exit 1).");
      expect(hasDockApp(appDir)).to.equal(true);
    });

    it('removeDockApp unpins only this app and deletes it', async () => {
      const mac = fakeMac(cacheDir);
      await build(mac.run, false);
      const others = ['file:///System/Applications/Mail.app/', `file://${join(root, 'Orgs.app')}/`];
      const dock = fakeMac(cacheDir, [others[0], appUrl, others[1], `file://${app}/`]);

      await removeDockApp({ appDir, run: dock.run });

      expect(dock.dock).to.deep.equal(others);
      const removes = dock.calls.filter((c) => c.startsWith('plutil -remove')).map((c) => c.split(' ')[2]);
      expect(removes).to.deep.equal(['persistent-apps.3', 'persistent-apps.1']);
      expect(dock.calls.filter((c) => /^(defaults import|killall)/.test(c))).to.have.length(2);
      expect(dock.calls.at(-1)).to.equal('killall Dock');
      expect(existsSync(app)).to.equal(false);
    });

    it('removeDockApp leaves the Dock alone when the app is not pinned', async () => {
      const dock = fakeMac(cacheDir, ['file:///System/Applications/Mail.app/']);
      await removeDockApp({ appDir, run: dock.run });
      expect(dock.calls.filter((c) => /^(defaults (write|import)|killall)/.test(c))).to.deep.equal([]);
    });

    it('a Dock with no saved apps counts as nothing pinned', async () => {
      const mac = fakeMac(cacheDir);
      const run: Run = (cmd, args) =>
        cmd === 'plutil' && args[1] === 'persistent-apps'
          ? Promise.resolve({ code: 1, stdout: '', stderr: 'dock.plist: Could not extract value, error: No value at that key path or invalid key path: persistent-apps' })
          : mac.run(cmd, args);

      await build(run);

      expect(mac.calls.filter((c) => c.startsWith('defaults write'))).to.have.length(1);
    });

    it('an unreadable Dock count stops the pin and keeps the app on remove', async () => {
      for (const answer of [failed, ok('not a number\n')]) {
        const mac = fakeMac(cacheDir, [appUrl]);
        const run: Run = (cmd, args) =>
          cmd === 'plutil' && args[1] === 'persistent-apps' ? Promise.resolve(answer) : mac.run(cmd, args);

        // eslint-disable-next-line no-await-in-loop
        expect((await failure(build(run)))?.message).to.equal("Couldn't read the Dock's settings.");
        // eslint-disable-next-line no-await-in-loop
        expect((await failure(removeDockApp({ appDir, run })))?.message).to.equal("Couldn't read the Dock's settings.");
        expect(hasDockApp(appDir)).to.equal(true);
        expect(mac.calls.filter((c) => /^(defaults (write|import)|killall)/.test(c))).to.deep.equal([]);
      }
    });

    it('a failed unpin keeps the app', async () => {
      const mac = fakeMac(cacheDir);
      await build(mac.run, false);
      const dock = fakeMac(cacheDir, [appUrl]);
      const run: Run = (cmd, args) => (cmd === 'defaults' && args[0] === 'import' ? Promise.resolve(failed) : dock.run(cmd, args));

      let error: Error | undefined;
      await removeDockApp({ appDir, run }).catch((e: Error) => {
        error = e;
      });

      expect(error?.message).to.equal("Couldn't unpin Org Launcher from the Dock: defaults import failed (exit 1).");
      expect(hasDockApp(appDir)).to.equal(true);
      expect(dock.calls.filter((c) => c.startsWith('killall'))).to.deep.equal([]);
    });

    it('unpins with the real plutil (macOS)', async () => {
      const fixture = join(root, 'dock.plist');
      const tile = (url: string): string =>
        `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${url}</string>` +
        '<key>_CFURLStringType</key><integer>15</integer></dict></dict><key>tile-type</key><string>file-tile</string></dict>';
      writeFileSync(
        fixture,
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>persistent-apps</key><array>' +
          `${tile('file:///System/Applications/Mail.app/')}<dict><key>tile-type</key><string>spacer-tile</string></dict>${tile(appUrl)}` +
          '</array><key>orientation</key><string>left</string></dict></plist>'
      );
      let imported = '';
      const run: Run = (cmd, args) => {
        if (cmd === 'defaults' && args[0] === 'export') {
          writeFileSync(args[2], readFileSync(fixture));
          return Promise.resolve(ok());
        }
        if (cmd === 'defaults' && args[0] === 'import') {
          imported = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', args[2]], { encoding: 'utf8' });
          return Promise.resolve(ok());
        }
        if (cmd === 'plutil') return runCommand(cmd, args);
        return Promise.resolve(ok());
      };

      await removeDockApp({ appDir, run });

      expect(JSON.parse(imported)).to.deep.equal({
        'persistent-apps': [
          { 'tile-data': { 'file-data': { _CFURLString: 'file:///System/Applications/Mail.app/', _CFURLStringType: 15 } }, 'tile-type': 'file-tile' },
          { 'tile-type': 'spacer-tile' },
        ],
        orientation: 'left',
      });
    });
  });

  const readdirIcons = (): string[] => readdirSync(join(app, 'Contents', 'Resources'));
});
