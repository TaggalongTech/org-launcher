import { Messages } from '@salesforce/core';
import { commandDeps, pageUrl, startsAtLogin, type CommandDeps, LauncherCommand } from '../../commandSupport.js';
import { PortInUseError, serverHealth } from '../../core/client.js';
import { launcherHome, StateStore } from '../../core/state.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@taggalongtech/org-launcher', 'launcher.status');

export type StatusResult = {
  state: 'running' | 'not-running' | 'port-in-use';
  port: number;
  url: string;
  /** The running server's version; null when it isn't running. */
  version: string | null;
  startsAtLogin: boolean;
  /** Whether the Dock app is there; null off macOS. */
  dockApp: boolean | null;
};

const yesNo = (value: boolean): string => (value ? 'yes' : 'no');

/** Whether the Dock app is there. A Dock module that can't load counts as no app. */
async function hasDockApp(deps: CommandDeps): Promise<boolean> {
  try {
    return (await deps.dock()).hasDockApp();
  } catch {
    return false;
  }
}

export default class Status extends LauncherCommand<StatusResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<StatusResult> {
    await this.parse(Status);
    const deps = commandDeps();
    const home = launcherHome();
    const port = new StateStore(home).settings().port;
    const url = pageUrl(port);
    const health = await serverHealth(port);
    const atLogin = await startsAtLogin(deps, home);
    const dockApp = deps.platform === 'darwin' ? await hasDockApp(deps) : null;

    if (health.state === 'ours') this.log(messages.getMessage('info.running', [url, health.version]));
    else if (health.state === 'down') this.log(messages.getMessage('info.notRunning'));
    else this.log(new PortInUseError(port).message);
    this.log(messages.getMessage('info.atLogin', [yesNo(atLogin)]));
    if (dockApp !== null) this.log(messages.getMessage('info.dock', [yesNo(dockApp)]));

    return {
      state: health.state === 'ours' ? 'running' : health.state === 'down' ? 'not-running' : 'port-in-use',
      port,
      url,
      version: health.state === 'ours' ? health.version : null,
      startsAtLogin: atLogin,
      dockApp,
    };
  }
}
