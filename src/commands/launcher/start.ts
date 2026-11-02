import { join } from 'node:path';
import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import {
  atLogin,
  atLoginElsewhere,
  commandDeps,
  healAtLogin,
  pageUrl,
  portInUse,
  registerAtLogin,
  serverScript,
  startServer,
  startsAtLogin,
  stopEverything,
  toSfError,
  waitForServer,
  LauncherCommand,
  UserError,
} from '../../commandSupport.js';
import { serverState } from '../../core/client.js';
import { launcherHome, StateStore } from '../../core/state.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@taggalongtech/org-launcher', 'launcher.start');
const launcherMessages = Messages.loadMessages('@taggalongtech/org-launcher', 'launcher');

export type StartResult = { url: string; port: number; started: boolean; startsAtLogin: boolean };

export default class Start extends LauncherCommand<StartResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    port: Flags.integer({ summary: messages.getMessage('flags.port.summary'), min: 1024, max: 65_535 }),
    'at-login': Flags.boolean({ summary: messages.getMessage('flags.at-login.summary') }),
  };

  public async run(): Promise<StartResult> {
    const { flags } = await this.parse(Start);
    const deps = commandDeps();
    const home = launcherHome();
    const store = new StateStore(home);
    const serverJs = serverScript();

    // Another launcher folder's login service is never replaced; said before anything changes.
    const before = flags['at-login'] ? await atLogin(deps, home) : null;
    if (before?.state === 'other') throw new UserError(atLoginElsewhere(before.home), 'AtLoginElsewhere');

    let settings = store.settings();
    if (flags.port !== undefined && flags.port !== settings.port) {
      // Checked before anything changes, so a taken port leaves a working setup as it was.
      if ((await serverState(flags.port)) === 'foreign') throw portInUse(flags.port);
      // The server on the old port would keep running there; it starts again on the new one below.
      if ((await serverState(settings.port)) === 'ours') await stopEverything(deps, home);
      try {
        settings = store.updateSettings({ port: flags.port });
      } catch (error) {
        throw toSfError(error);
      }
    }
    const port = settings.port;
    // A login service left on an old node (an sf CLI update) is registered again first.
    const healed = await healAtLogin(deps, serverJs, home);
    const state = healed ? await waitForServer(port) : await serverState(port);
    if (state === 'foreign') throw portInUse(port);

    let registered = false;
    if (flags['at-login']) {
      if (!(await startsAtLogin(deps, home))) {
        // On failure the server is running again on its own, and the error says why.
        await registerAtLogin(deps, serverJs, home);
        registered = true;
      }
      store.updateSettings({ asked: { ...store.settings().asked, atLogin: true } });
    }
    if (!registered && state === 'down') await startServer(deps, serverJs, home);

    const now = await waitForServer(port);
    if (now === 'foreign') throw portInUse(port);
    if (now === 'down') throw new UserError(launcherMessages.getMessage('error.didNotStart', [join(home, 'server.log')]));

    const url = pageUrl(port);
    const started = registered || state === 'down';
    this.log(messages.getMessage(started ? 'info.running' : 'info.alreadyRunning', [url]));
    if (registered) this.log(messages.getMessage('info.atLogin'));
    return { url, port, started, startsAtLogin: await startsAtLogin(deps, home) };
  }
}
