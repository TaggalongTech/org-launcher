import { Messages } from '@salesforce/core';
import { Args } from '@oclif/core';
import { commandDeps, orgLines, toSfError, LauncherCommand } from '../../commandSupport.js';
import { updateOrg, type OrgSummary } from '../../core/client.js';
import { launcherHome, StateStore } from '../../core/state.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@taggalongtech/org-launcher', 'launcher.note');

export type NoteResult = OrgSummary & { org: string };

export default class Note extends LauncherCommand<NoteResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly args = {
    org: Args.string({ description: messages.getMessage('args.org.description'), required: true }),
    text: Args.string({ description: messages.getMessage('args.text.description'), required: true }),
  };

  public async run(): Promise<NoteResult> {
    const { args } = await this.parse(Note);
    let summary: OrgSummary;
    try {
      summary = await updateOrg(
        args.org,
        { note: args.text },
        { store: new StateStore(launcherHome()), logins: commandDeps().logins }
      );
    } catch (error) {
      throw toSfError(error);
    }
    for (const line of orgLines(args.org, summary)) this.log(line);
    return { org: args.org, ...summary };
  }
}
