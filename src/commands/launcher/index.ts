import { join } from 'node:path';
import { Messages } from '@salesforce/core';
import {
  atLogin,
  commandDeps,
  healAtLogin,
  pageUrl,
  portInUse,
  registerAtLogin,
  serverScript,
  startServer,
  waitForServer,
  type CommandDeps,
  LauncherCommand,
  UserError,
} from '../../commandSupport.js';
import { serverState } from '../../core/client.js';
import { resolveOpen } from '../../core/openTarget.js';
import { rememberProject } from '../../core/projects.js';
import { launcherHome, StateStore, type OrgEntry } from '../../core/state.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@taggalong/org-launcher', 'launcher');

export type LauncherResult = { url: string; started: boolean };

/** No org: resolveOpen then gives the browser chosen for every org. */
const NO_ORG: OrgEntry = { tags: [], note: '', hidden: false, mainLogin: null, open: null };

export default class Launcher extends LauncherCommand<LauncherResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<LauncherResult> {
    await this.parse(Launcher);
    const deps = commandDeps();
    const home = launcherHome();
    const store = new StateStore(home);
    try {
      rememberProject(deps.cwd(), store);
    } catch {
      // A project the launcher can't remember never stops the page from opening.
    }
    const settings = store.settings();
    const port = settings.port;
    const serverJs = serverScript();

    // A login service left on an old node (an sf CLI update) is registered again first.
    const healed = await healAtLogin(deps, serverJs, home);
    const state = healed ? await waitForServer(port) : await serverState(port);
    if (state === 'foreign') throw portInUse(port);
    if (state === 'down') {
      await startServer(deps, serverJs, home);
      const now = await waitForServer(port);
      if (now === 'foreign') throw portInUse(port);
      if (now === 'down') throw new UserError(messages.getMessage('error.didNotStart', [join(home, 'server.log')]));
    }

    const url = pageUrl(port);
    try {
      await deps.open(url, resolveOpen(NO_ORG, settings), true);
    } catch {
      this.warn(messages.getMessage('warn.open', [url]));
    }
    this.log(messages.getMessage(state === 'down' ? 'info.started' : 'info.opened', [url]));

    if (!this.jsonEnabled() && deps.interactive()) await this.firstRun(deps, store, serverJs, home);
    return { url, started: state === 'down' };
  }

  /** Asks once about starting at login and, on macOS, the Dock app. Each question is recorded as asked. */
  private async firstRun(deps: CommandDeps, store: StateStore, serverJs: string, home: string): Promise<void> {
    // Another launcher folder's login service is never replaced, so there's nothing to ask.
    if (!store.settings().asked.atLogin && (await atLogin(deps, home)).state !== 'other') {
      const yes = await deps.ask(messages.getMessage('prompt.atLogin'));
      store.updateSettings({ asked: { ...store.settings().asked, atLogin: true } });
      if (yes) {
        try {
          await registerAtLogin(deps, serverJs, home);
          this.log(messages.getMessage('info.atLogin'));
        } catch {
          // The server is running again on its own, so the page still works.
          this.warn(messages.getMessage('warn.atLogin'));
        }
      }
    }
    if (deps.platform === 'darwin' && !store.settings().asked.dock) {
      const yes = await deps.ask(messages.getMessage('prompt.dock'));
      const settings = store.updateSettings({ asked: { ...store.settings().asked, dock: true } });
      if (yes) {
        try {
          const dock = await deps.dock();
          await dock.buildDockApp(home, { port: settings.port, defaultOpen: settings.defaultOpen });
          this.log(messages.getMessage('info.dock'));
        } catch {
          this.warn(messages.getMessage('warn.dock'));
        }
      }
    }
  }
}
