import { expect } from 'chai';
import { launchCommand, openUrl, spawnDetached, windowsCommandLine, type Launch } from '../../src/os/browser.js';

const LINK = 'https://example.my.salesforce.com/secur/frontdoor.jsp?otp=abc&startURL=%2Flightning';

describe('browser: launch commands', () => {
  it('darwin: null target uses open', () => {
    expect(launchCommand(LINK, null, 'darwin')).to.deep.equal({ cmd: 'open', args: [LINK] });
  });

  it('darwin: chrome with a profile', () => {
    expect(launchCommand(LINK, { browser: 'chrome', profile: 'Default' }, 'darwin')).to.deep.equal({
      cmd: 'open',
      args: ['-na', 'Google Chrome', '--args', '--profile-directory=Default', LINK],
    });
  });

  it('darwin: edge with a profile', () => {
    expect(launchCommand(LINK, { browser: 'edge', profile: 'Profile 1' }, 'darwin')).to.deep.equal({
      cmd: 'open',
      args: ['-na', 'Microsoft Edge', '--args', '--profile-directory=Profile 1', LINK],
    });
  });

  it('darwin: brave with a profile', () => {
    expect(launchCommand(LINK, { browser: 'brave', profile: 'Profile 2' }, 'darwin')).to.deep.equal({
      cmd: 'open',
      args: ['-na', 'Brave Browser', '--args', '--profile-directory=Profile 2', LINK],
    });
  });

  it('darwin: firefox with a profile', () => {
    expect(launchCommand(LINK, { browser: 'firefox', profile: 'work' }, 'darwin')).to.deep.equal({
      cmd: 'open',
      args: ['-na', 'Firefox', '--args', '-P', 'work', '-new-tab', LINK],
    });
  });

  it('darwin: no profile drops the profile argument', () => {
    expect(launchCommand(LINK, { browser: 'chrome' }, 'darwin')).to.deep.equal({
      cmd: 'open',
      args: ['-na', 'Google Chrome', '--args', LINK],
    });
    expect(launchCommand(LINK, { browser: 'firefox' }, 'darwin')).to.deep.equal({
      cmd: 'open',
      args: ['-na', 'Firefox', '--args', '-new-tab', LINK],
    });
  });

  it('profile with a space stays one argument', () => {
    const { args } = launchCommand(LINK, { browser: 'chrome', profile: 'Profile 3' }, 'darwin');
    expect(args).to.include('--profile-directory=Profile 3');
    const firefox = launchCommand(LINK, { browser: 'firefox', profile: 'dev work' }, 'linux');
    expect(firefox.args).to.deep.equal(['-P', 'dev work', '-new-tab', LINK]);
  });

  it('appMode only for chromium', () => {
    expect(launchCommand(LINK, { browser: 'chrome', profile: 'Profile 3' }, 'darwin', true)).to.deep.equal({
      cmd: 'open',
      args: ['-na', 'Google Chrome', '--args', '--profile-directory=Profile 3', `--app=${LINK}`],
    });
    expect(launchCommand(LINK, { browser: 'firefox' }, 'darwin', true).args).to.deep.equal([
      '-na',
      'Firefox',
      '--args',
      '-new-tab',
      LINK,
    ]);
    expect(launchCommand(LINK, null, 'darwin', true)).to.deep.equal({ cmd: 'open', args: [LINK] });
  });

  it('linux: null target uses xdg-open', () => {
    expect(launchCommand(LINK, null, 'linux')).to.deep.equal({ cmd: 'xdg-open', args: [LINK] });
  });

  it('linux: each browser runs its own command', () => {
    expect(launchCommand(LINK, { browser: 'chrome', profile: 'Default' }, 'linux')).to.deep.equal({
      cmd: 'google-chrome',
      args: ['--profile-directory=Default', LINK],
    });
    expect(launchCommand(LINK, { browser: 'edge' }, 'linux').cmd).to.equal('microsoft-edge');
    expect(launchCommand(LINK, { browser: 'brave' }, 'linux').cmd).to.equal('brave-browser');
    expect(launchCommand(LINK, { browser: 'firefox' }, 'linux')).to.deep.equal({
      cmd: 'firefox',
      args: ['-new-tab', LINK],
    });
  });

  it('win32: null target uses cmd start with an empty title', () => {
    expect(launchCommand(LINK, null, 'win32')).to.deep.equal({ cmd: 'cmd', args: ['/c', 'start', '', LINK] });
  });

  it('win32: a browser runs through cmd start with its exe', () => {
    expect(launchCommand(LINK, { browser: 'edge', profile: 'Profile 3' }, 'win32', true)).to.deep.equal({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'msedge', '--profile-directory=Profile 3', `--app=${LINK}`],
    });
    expect(launchCommand(LINK, { browser: 'chrome' }, 'win32').args[3]).to.equal('chrome');
    expect(launchCommand(LINK, { browser: 'brave' }, 'win32').args[3]).to.equal('brave');
    expect(launchCommand(LINK, { browser: 'firefox', profile: 'work' }, 'win32').args).to.deep.equal([
      '/c',
      'start',
      '',
      'firefox',
      '-P',
      'work',
      '-new-tab',
      LINK,
    ]);
  });

  it('win32: the command line quotes everything cmd could read as an operator', () => {
    const line = windowsCommandLine(launchCommand(LINK, { browser: 'chrome', profile: 'Profile 3' }, 'win32'));
    expect(line).to.equal(`/c start "" chrome "--profile-directory=Profile 3" "${LINK}"`);
  });

  it('win32: an argument with a double quote is refused without showing it', () => {
    expect(() => windowsCommandLine({ cmd: 'cmd', args: ['/c', 'start', '', 'a"&calc'] }))
      .to.throw()
      .with.property('message')
      .that.does.not.include('calc');
  });
});

describe('browser: openUrl', () => {
  it('passes the launch command to the spawner', async () => {
    const launched: Launch[] = [];
    await openUrl(LINK, { browser: 'chrome', profile: 'Profile 3' }, async (l) => {
      launched.push(l);
    });
    expect(launched).to.have.length(1);
    expect(launched[0].args.at(-1)).to.equal(LINK);
  });

  it('opens as an app window when asked', async () => {
    const launched: Launch[] = [];
    const record = async (l: Launch): Promise<void> => {
      launched.push(l);
    };
    await openUrl(LINK, { browser: 'chrome', profile: 'Profile 3' }, record, () => {}, true);
    await openUrl(LINK, { browser: 'chrome', profile: 'Profile 3' }, record, () => {});
    expect(launched[0].args.at(-1)).to.equal(`--app=${LINK}`);
    expect(launched[1].args.at(-1)).to.equal(LINK);
  });

  it('refuses a link that is not a web address', async () => {
    const launched: Launch[] = [];
    const spawn = async (l: Launch): Promise<void> => {
      launched.push(l);
    };
    for (const bad of ['--gpu-launcher=/bin/sh', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      let error: unknown;
      try {
        // eslint-disable-next-line no-await-in-loop
        await openUrl(bad, null, spawn, () => {});
      } catch (e) {
        error = e;
      }
      expect(error, bad).to.be.instanceOf(Error);
      expect((error as Error).message).to.not.include(bad);
    }
    expect(launched).to.have.length(0);
  });

  it('openUrl never writes the url to the log', async () => {
    const logged: string[] = [];
    const log = (message: string): void => void logged.push(message);

    await openUrl(LINK, { browser: 'chrome', profile: 'Profile 3' }, async () => {}, log);
    await openUrl(LINK, null, async () => {}, log);

    let error: unknown;
    try {
      await openUrl(
        LINK,
        { browser: 'brave' },
        async (l) => {
          // Node's own spawn errors carry the full argv; openUrl must not pass them on.
          throw Object.assign(new Error(`spawn ${l.cmd} ${l.args.join(' ')} ENOENT`), { spawnargs: l.args });
        },
        log
      );
    } catch (e) {
      error = e;
    }

    expect(logged.length).to.be.greaterThan(0);
    for (const message of logged) expect(message).to.not.include('frontdoor');
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.not.include('frontdoor');
    expect((error as Error).message).to.include('Brave');
    expect(error).to.not.have.property('cause');
    expect(error).to.not.have.property('spawnargs');
  });
});

describe('browser: spawnDetached', () => {
  const node = process.execPath;

  it('a hand-off command that exits 0 resolves', async () => {
    await spawnDetached({ cmd: node, args: ['-e', 'process.exit(0)'] }, true);
  });

  it('a hand-off command that fails rejects', async () => {
    let error: unknown;
    try {
      await spawnDetached({ cmd: node, args: ['-e', 'process.exit(3)', 'frontdoor'] }, true);
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.not.include('frontdoor');
  });

  it('a missing program rejects without its arguments', async () => {
    let error: unknown;
    try {
      await spawnDetached({ cmd: 'org-launcher-no-such-program', args: ['frontdoor'] });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.not.include('frontdoor');
    expect(error).to.not.have.property('spawnargs');
  });

  it('a browser started directly resolves once it starts', async () => {
    await spawnDetached({ cmd: node, args: ['-e', 'setTimeout(() => {}, 200)'] }, false);
  });
});
