import { Messages } from '@salesforce/core';
import { commandDeps, stopEverything, LauncherCommand } from '../../commandSupport.js';
import { launcherHome } from '../../core/state.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@taggalongtech/org-launcher', 'launcher.stop');

export type StopResult = { stopped: boolean; startsAtLogin: boolean };

export default class Stop extends LauncherCommand<StopResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<StopResult> {
    await this.parse(Stop);
    const { stopped, atLogin } = await stopEverything(commandDeps(), launcherHome());
    this.log(messages.getMessage(atLogin ? 'info.stoppedUntilLogin' : stopped ? 'info.stopped' : 'info.notRunning'));
    return { stopped, startsAtLogin: atLogin };
  }
}
