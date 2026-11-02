import { readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { commandDeps, startsAtLogin, LauncherCommand, UserError } from '../../commandSupport.js';
import { launcherHome } from '../../core/state.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@taggalong/org-launcher', 'launcher.uninstall');

export type UninstallResult = { purged: boolean; home: string };

/** Every file Org Launcher writes in its folder, backups and temp files included. Nothing else is deleted. */
const OUR_FILES = /^(?:(?:state|settings|cache)\.json(?:\.bad-\d+|\..+\.tmp)?|server\.(?:log|pid)|state\.lock)$/;

/** Deletes Org Launcher's own files, then the folder if that left it empty. True when all of them went. */
function purge(home: string): boolean {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return true; // No folder, nothing to delete.
  }
  let ok = true;
  for (const name of names.filter((n) => OUR_FILES.test(n))) {
    try {
      unlinkSync(join(home, name));
    } catch {
      ok = false;
    }
  }
  try {
    rmdirSync(home);
  } catch {
    // Something else is in the folder; it stays.
  }
  return ok;
}

export default class Uninstall extends LauncherCommand<UninstallResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    purge: Flags.boolean({ summary: messages.getMessage('flags.purge.summary') }),
  };

  public async run(): Promise<UninstallResult> {
    const { flags } = await this.parse(Uninstall);
    const deps = commandDeps();
    const home = launcherHome();
    let complete = true;

    try {
      // Only this folder's login service: another folder's is left as it is.
      if (await startsAtLogin(deps, home)) await deps.loginService().unregister();
    } catch {
      this.warn(messages.getMessage('warn.atLogin'));
      complete = false;
    }
    try {
      await deps.stopServer(home);
    } catch {
      this.warn(messages.getMessage('warn.stop'));
      complete = false;
    }
    const mac = deps.platform === 'darwin';
    if (mac) {
      try {
        const dock = await deps.dock();
        if (dock.hasDockApp()) await dock.removeDockApp();
      } catch {
        this.warn(messages.getMessage('warn.dock'));
        complete = false;
      }
    }
    if (flags.purge && !purge(home)) {
      this.warn(messages.getMessage('warn.purge', [home]));
      complete = false;
    }
    if (!complete) throw new UserError(messages.getMessage('error.incomplete'));

    this.log(messages.getMessage(mac ? 'info.removedDock' : 'info.removed'));
    this.log(flags.purge ? messages.getMessage('info.purged') : messages.getMessage('info.kept', [home]));
    this.log(messages.getMessage('info.plugin'));
    return { purged: flags.purge, home };
  }
}
