import { Messages } from '@salesforce/core';
import { Args } from '@oclif/core';
import { Flags } from '@salesforce/sf-plugins-core';
import { commandDeps, orgLines, toSfError, LauncherCommand, UserError } from '../../commandSupport.js';
import { updateOrg, type OrgPatch, type OrgSummary } from '../../core/client.js';
import { launcherHome, StateStore } from '../../core/state.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@taggalong/org-launcher', 'launcher.tag');

export type TagResult = OrgSummary & { org: string };

export default class Tag extends LauncherCommand<TagResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');
  /** Tags to add follow the org, as many as you like. */
  public static readonly strict = false;

  public static readonly args = {
    org: Args.string({ description: messages.getMessage('args.org.description'), required: true }),
  };

  public static readonly flags = {
    remove: Flags.string({ summary: messages.getMessage('flags.remove.summary'), multiple: true, exclusive: ['set'] }),
    set: Flags.string({ summary: messages.getMessage('flags.set.summary'), multiple: true }),
  };

  public async run(): Promise<TagResult> {
    const { args, argv, flags } = await this.parse(Tag);
    const added = (argv as string[]).slice(1);
    if (flags.set && added.length > 0) throw new UserError(messages.getMessage('error.setWithTags'));
    const patch: OrgPatch = flags.set
      ? { tags: flags.set }
      : { ...(added.length > 0 ? { addTags: added } : {}), ...(flags.remove ? { removeTags: flags.remove } : {}) };

    const deps = commandDeps();
    let summary: OrgSummary;
    try {
      summary = await updateOrg(args.org, patch, { store: new StateStore(launcherHome()), logins: deps.logins });
    } catch (error) {
      throw toSfError(error);
    }
    for (const line of orgLines(args.org, summary)) this.log(line);
    return { org: args.org, ...summary };
  }
}
