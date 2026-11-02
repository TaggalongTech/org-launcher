import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { commandDeps, LauncherCommand, UserError } from '../../commandSupport.js';
import { launcherHome, StateStore } from '../../core/state.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@taggalongtech/org-launcher', 'launcher.dock');

/** The app's path after adding it; null after --remove. */
export type DockResult = { app: string | null; removed: boolean };

export default class Dock extends LauncherCommand<DockResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    remove: Flags.boolean({ summary: messages.getMessage('flags.remove.summary') }),
  };

  public async run(): Promise<DockResult> {
    const { flags } = await this.parse(Dock);
    const deps = commandDeps();
    if (deps.platform !== 'darwin') throw new UserError(messages.getMessage('error.notMac'));
    const dock = await deps.dock();
    try {
      if (flags.remove) {
        await dock.removeDockApp();
        this.log(messages.getMessage('info.removed'));
        return { app: null, removed: true };
      }
      const home = launcherHome();
      const { port, defaultOpen } = new StateStore(home).settings();
      const app = await dock.buildDockApp(home, { port, defaultOpen });
      this.log(messages.getMessage('info.added'));
      return { app, removed: false };
    } catch (error) {
      // The Dock module's messages are written for people and hold no secrets.
      throw new UserError(error instanceof Error ? error.message : String(error));
    }
  }
}
