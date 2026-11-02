/**
 * What the page's buttons do: open an org, log out of it, and save what people note about it.
 * Login links go straight from loginUrl to open: they are never returned, logged or put in an error.
 */
import { spawn } from 'node:child_process';
import type { Inventory, OrgRow } from '../core/inventory.js';
import type { LoginUrl } from '../core/loginUrl.js';
import { resolveOpen } from '../core/openTarget.js';
import type { OpenTarget, OrgEntry, Settings, StateStore } from '../core/state.js';
import {
  checkOrgId,
  normalizeMainLogin,
  normalizeNote,
  normalizeOpenTarget,
  normalizeTags,
  ValidationError,
} from '../core/validate.js';
import { windowsCommandLine } from '../os/browser.js';

/** Runs a command to the end; rejects when it can't start or exits non-zero. */
export type Runner = (cmd: string, args: string[]) => Promise<void>;

export type ActionDeps = {
  inventory: Pick<Inventory, 'rows' | 'startRefresh' | 'status' | 'forget'>;
  store: StateStore;
  loginUrl: LoginUrl;
  /** Opens a link in a browser; openUrl on a real machine. */
  open: (url: string, target: OpenTarget | null) => Promise<void>;
  run: Runner;
};

/** An error with an HTTP status and a message to show as is. */
export class ActionError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

const NOT_AN_ID = "That isn't an 18-character Salesforce org id. Refresh the page.";
const GONE = "That org isn't logged in to the sf CLI any more. Refresh the page.";
const NOT_A_LOGIN = "That login isn't one of this org's logins. Refresh the page.";
const NO_LINK = "Couldn't get a login link for this org. Its login may have expired. Log in again with sf org login web.";
const LOGOUT_FAILED = "Couldn't log out of every login for this org. Run sf org list to see what's left.";

type Body = Record<string, unknown>;

/** The org's row, after checking the id is an 18-character org id. */
function findRow(deps: ActionDeps, id: unknown): OrgRow {
  if (typeof id !== 'string' || id.length !== 18) throw new ValidationError(NOT_AN_ID);
  checkOrgId(id);
  const row = deps.inventory.rows().find((r) => r.id === id);
  if (!row) throw new ActionError(404, GONE);
  return row;
}

function checkLogin(row: OrgRow, username: unknown): string {
  const login = row.logins.find((l) => l.username === username);
  if (!login) throw new ValidationError(NOT_A_LOGIN);
  return login.username;
}

/** Opens the org in its browser: the org's own, then its tags', then the default. */
export async function openOrg(deps: ActionDeps, body: Body): Promise<void> {
  const row = findRow(deps, body.id);
  const username =
    body.username === undefined ? row.logins.find((l) => l.main)?.username ?? '' : checkLogin(row, body.username);
  const target = resolveOpen(deps.store.get(row.id), deps.store.settings());
  let url: string;
  try {
    url = await deps.loginUrl(username);
  } catch {
    throw new ActionError(502, NO_LINK);
  }
  try {
    await deps.open(url, target);
  } catch (error) {
    // openUrl's own messages are safe to show; anything else could hold the link.
    const message = error instanceof Error && !error.message.includes(url) ? error.message : "Couldn't open the browser.";
    throw new ActionError(500, message);
  }
}

/**
 * Logs out of every login of the org with the sf CLI, then refreshes the list. Once every logout
 * worked, the org leaves the list at once, even while a refresh runs.
 */
export async function removeOrg(deps: ActionDeps, body: Body): Promise<void> {
  const row = findRow(deps, body.id);
  let failed = false;
  for (const login of row.logins) {
    try {
      // One at a time: the sf CLI's auth files don't like parallel writes.
      // eslint-disable-next-line no-await-in-loop
      await deps.run('sf', ['org', 'logout', '--target-org', login.username, '--no-prompt']);
    } catch {
      failed = true;
    }
  }
  if (!failed) deps.inventory.forget(row.id);
  deps.inventory.startRefresh();
  if (failed) throw new ActionError(500, LOGOUT_FAILED);
}

/** Saves tags, note, hidden, main login and browser for one org; returns its row. Checks everything first. */
export function updateOrg(deps: ActionDeps, body: Body): OrgRow {
  const row = findRow(deps, body.id);
  const patch: Partial<OrgEntry> = {};
  if (body.tags !== undefined) patch.tags = normalizeTags(body.tags as string[]);
  if (body.note !== undefined) patch.note = normalizeNote(body.note as string);
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') throw new ValidationError('Hidden must be true or false.');
    patch.hidden = body.hidden;
  }
  if (body.mainLogin !== undefined) {
    const mainLogin = normalizeMainLogin(body.mainLogin as string | null);
    patch.mainLogin = mainLogin === null ? null : checkLogin(row, mainLogin);
  }
  if (body.open !== undefined) patch.open = normalizeOpenTarget(body.open as OpenTarget | null);
  const addTags = body.addTags === undefined ? [] : normalizeTags(body.addTags as string[]);
  const removeTags = body.removeTags === undefined ? [] : normalizeTags(body.removeTags as string[]);

  if (Object.keys(patch).length > 0) deps.store.update(row.id, patch);
  if (addTags.length > 0) deps.store.addTags(row.id, addTags);
  if (removeTags.length > 0) deps.store.removeTags(row.id, removeTags);
  return deps.inventory.rows().find((r) => r.id === row.id) ?? row;
}

export type PageSettings = Pick<Settings, 'defaultOpen' | 'tagOpen'>;

/** Changes the settings the page can change: the browsers. The port changes with sf launcher start --port. */
export function updateSettings(deps: ActionDeps, body: Body): PageSettings {
  const patch: Partial<Settings> = {};
  if (body.defaultOpen !== undefined) patch.defaultOpen = body.defaultOpen as OpenTarget | null;
  if (body.tagOpen !== undefined) patch.tagOpen = body.tagOpen as Record<string, OpenTarget>;
  const settings = deps.store.updateSettings(patch);
  return { defaultOpen: settings.defaultOpen, tagOpen: settings.tagOpen };
}

/** Runs the sf CLI with its output ignored. On Windows sf is a .cmd file, so it goes through cmd with quoting. */
export const runSf: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', [windowsCommandLine({ cmd: 'cmd', args: ['/c', cmd, ...args] })], {
            stdio: 'ignore',
            windowsVerbatimArguments: true,
            windowsHide: true,
          })
        : spawn(cmd, args, { stdio: 'ignore' });
    // Our own errors only: Node's carry the argument list, and so a username.
    child.once('error', () => reject(new Error(`could not start ${cmd}`)));
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${String(code)}`))));
  });
